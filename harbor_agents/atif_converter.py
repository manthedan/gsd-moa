"""Convert Pi JSONL logs to Harbor ATIF trajectories.

This module intentionally has no Harbor imports so it can run inside a task
container where the benchmark harness package may not be installed. The output
is validated by Harbor on the host side when available.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ATIF_VERSION = "ATIF-v1.7"


def convert_pi_jsonl_to_atif(
    input_path: Path,
    output_path: Path,
    *,
    agent_name: str = "pi-gsd-moa",
    agent_version: str = "unknown",
    model_name: str | None = None,
    session_path: Path | None = None,
    trace_dir: Path | None = None,
) -> dict[str, Any]:
    events = list(_jsonl_events(input_path))
    trajectory = build_trajectory(
        events,
        agent_name=agent_name,
        agent_version=agent_version,
        model_name=model_name,
        session_path=session_path,
        source_path=input_path,
        trace_dir=trace_dir,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(trajectory, indent=2, ensure_ascii=False) + "\n")
    return trajectory


def build_trajectory(
    events: list[dict[str, Any]],
    *,
    agent_name: str = "pi-gsd-moa",
    agent_version: str = "unknown",
    model_name: str | None = None,
    session_path: Path | None = None,
    source_path: Path | None = None,
    trace_dir: Path | None = None,
) -> dict[str, Any]:
    session_event = next((event for event in events if event.get("type") == "session"), {})
    session_id = _string_or_none(session_event.get("id")) or f"pi-gsd-moa-{_now_iso()}"
    default_model = model_name or _first_assistant_model(events)
    trace_cache: dict[str, dict[str, Any] | None] = {}
    steps: list[dict[str, Any]] = []
    subagent_trajectories: list[dict[str, Any]] = []
    last_agent_step: dict[str, Any] | None = None
    seen_message_keys: set[tuple[str | None, str | None, str]] = set()

    for event in events:
        if event.get("type") != "message_end":
            continue
        message = event.get("message")
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role in {"user", "system"}:
            key = (_string_or_none(role), _string_or_none(message.get("timestamp")), _content_text(message.get("content")))
            if key in seen_message_keys:
                continue
            seen_message_keys.add(key)
            steps.append(
                _drop_none(
                    {
                        "step_id": len(steps) + 1,
                        "timestamp": _timestamp(message.get("timestamp")),
                        "source": role,
                        "message": _content_text(message.get("content")),
                        "extra": _drop_none({"pi_role": role}),
                    }
                )
            )
            last_agent_step = None
        elif role == "assistant":
            step = _assistant_step(message, len(steps) + 1, default_model)
            refs, subs = _subagent_refs_for_message(
                message,
                session_id,
                step["step_id"],
                agent_version,
                _trace_for_message(message, trace_dir, trace_cache),
            )
            if refs:
                _append_observation_result(
                    step,
                    {
                        "content": "gsd-moa delegated reference/synthesis calls",
                        "subagent_trajectory_ref": refs,
                    },
                )
                subagent_trajectories.extend(subs)
            steps.append(step)
            last_agent_step = step
        elif role == "toolResult":
            result = _tool_result_observation(message, last_agent_step)
            if last_agent_step is not None:
                _append_observation_result(last_agent_step, result)
            else:
                # ATIF does not have a tool source. If a malformed/incomplete Pi
                # stream has an orphan result, keep it as a system observation.
                steps.append(
                    {
                        "step_id": len(steps) + 1,
                        "timestamp": _timestamp(message.get("timestamp")),
                        "source": "system",
                        "message": "Orphan tool result",
                        "observation": {"results": [result]},
                        "extra": {"pi_role": "toolResult"},
                    }
                )
                last_agent_step = None

    if not steps:
        steps.append(
            {
                "step_id": 1,
                "timestamp": _timestamp(session_event.get("timestamp")) or _now_iso(),
                "source": "system",
                "message": "Pi run produced no message_end events.",
            }
        )

    final_metrics = _final_metrics_from_steps(steps, subagent_trajectories)
    trajectory: dict[str, Any] = _drop_none(
        {
            "schema_version": ATIF_VERSION,
            "session_id": session_id,
            "trajectory_id": f"{_safe_id(session_id)}:root",
            "agent": _drop_none(
                {
                    "name": agent_name,
                    "version": agent_version,
                    "model_name": default_model,
                    "extra": _drop_none(
                        {
                            "pi_session_cwd": session_event.get("cwd"),
                            "pi_session_timestamp": session_event.get("timestamp"),
                            "session_log": str(session_path) if session_path else None,
                        }
                    ),
                }
            ),
            "steps": steps,
            "notes": (
                "Converted from Pi JSONL logs. gsd-moa inner calls are represented "
                "as embedded subagent trajectories when diagnostics are present; "
                "inner prompt/output text is included when the referenced gsd-moa trace file is available; "
                "otherwise inner calls fall back to metadata-only subagent trajectories."
            ),
            "final_metrics": final_metrics,
            "extra": _drop_none(
                {
                    "source_format": "pi-jsonl",
                    "source_event_count": len(events),
                    "source_path": str(source_path) if source_path else None,
                }
            ),
            "subagent_trajectories": subagent_trajectories or None,
        }
    )
    return trajectory


def _assistant_step(message: dict[str, Any], step_id: int, default_model: str | None) -> dict[str, Any]:
    text = _content_text(message.get("content"))
    reasoning = _thinking_text(message.get("content"))
    tool_calls = _tool_calls(message.get("content"))
    if not text and tool_calls:
        text = "Tool call request: " + ", ".join(call["function_name"] for call in tool_calls)
    diagnostics = _gsd_moa_diagnostics(message)
    extra = _drop_none(
        {
            "pi_provider": message.get("provider"),
            "pi_api": message.get("api"),
            "pi_response_id": message.get("responseId"),
            "pi_stop_reason": message.get("stopReason"),
            "gsd_moa": diagnostics,
        }
    )
    return _drop_none(
        {
            "step_id": step_id,
            "timestamp": _timestamp(message.get("timestamp")),
            "source": "agent",
            "model_name": message.get("model") or default_model,
            "message": text,
            "reasoning_content": reasoning or None,
            "tool_calls": tool_calls or None,
            "metrics": _metrics(message.get("usage")),
            "llm_call_count": _llm_call_count_from_diagnostics(diagnostics),
            "extra": extra or None,
        }
    )


def _subagent_refs_for_message(
    message: dict[str, Any],
    session_id: str,
    parent_step_id: int,
    agent_version: str,
    trace: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    diagnostics = _gsd_moa_diagnostics(message)
    if not isinstance(diagnostics, dict):
        return [], []
    inner_calls = diagnostics.get("innerCalls")
    if not isinstance(inner_calls, list):
        return [], []
    refs: list[dict[str, Any]] = []
    trajectories: list[dict[str, Any]] = []
    for index, call in enumerate(inner_calls):
        if not isinstance(call, dict) or call.get("role") == "primary":
            continue
        trace_call = _matching_trace_reference_call(trace, call)
        role = _string_or_none(call.get("role")) or "subagent"
        call_id = _string_or_none(call.get("id")) or str(index)
        trajectory_id = _safe_id(f"{session_id}:moa:{parent_step_id}:{role}:{call_id}")
        route = trace_call.get("route") if isinstance(trace_call, dict) and isinstance(trace_call.get("route"), dict) else {}
        provider = call.get("provider") or route.get("provider")
        model_name = call.get("model") or route.get("model")
        model = "/".join(str(part) for part in [provider, model_name] if part)
        cache_hit = call.get("cacheHit") is True or (isinstance(trace_call, dict) and trace_call.get("cacheHit") is True)
        usage = call.get("usage") if isinstance(call.get("usage"), dict) else None
        if usage is None and isinstance(trace_call, dict) and isinstance(trace_call.get("usage"), dict):
            usage = trace_call.get("usage")
        sub_steps = _subagent_steps(call, trace_call, model, usage, cache_hit)
        trajectories.append(
            _drop_none(
                {
                    "schema_version": ATIF_VERSION,
                    "trajectory_id": trajectory_id,
                    "agent": _drop_none(
                        {
                            "name": f"gsd-moa-{role}",
                            "version": agent_version,
                            "model_name": model or None,
                            "extra": _drop_none(
                                {
                                    "label": call.get("label"),
                                    "provider": provider,
                                    "model": model_name,
                                }
                            ),
                        }
                    ),
                    "steps": sub_steps,
                    "notes": "Subagent trajectory reconstructed from gsd-moa diagnostics and trace output when available.",
                    "final_metrics": _final_metrics_from_steps(sub_steps, []),
                    "extra": {"parent_step_id": parent_step_id, "gsd_moa_inner_call": call},
                }
            )
        )
        refs.append(
            _drop_none(
                {
                    "trajectory_id": trajectory_id,
                    "session_id": session_id,
                    "extra": _drop_none(
                        {
                            "role": role,
                            "id": call.get("id"),
                            "label": call.get("label"),
                            "cache_hit": cache_hit,
                        }
                    ),
                }
            )
        )
    return refs, trajectories


def _subagent_steps(
    call: dict[str, Any],
    trace_call: dict[str, Any] | None,
    model: str,
    usage: dict[str, Any] | None,
    cache_hit: bool,
) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = []
    context = trace_call.get("context") if isinstance(trace_call, dict) and isinstance(trace_call.get("context"), dict) else {}
    system_prompt = context.get("systemPrompt")
    if isinstance(system_prompt, str) and system_prompt:
        steps.append({"step_id": len(steps) + 1, "source": "system", "message": system_prompt})
    messages = context.get("messages") if isinstance(context.get("messages"), list) else []
    for context_message in messages:
        if not isinstance(context_message, dict):
            continue
        role = context_message.get("role")
        if role not in {"user", "system"}:
            continue
        steps.append(
            _drop_none(
                {
                    "step_id": len(steps) + 1,
                    "timestamp": _timestamp(context_message.get("timestamp")),
                    "source": role,
                    "message": _content_text(context_message.get("content")) or str(context_message.get("content", "")),
                    "is_copied_context": True,
                }
            )
        )
    text = _trace_call_text(trace_call) or _subagent_message(call, cache_hit)
    started_at = trace_call.get("startedAt") if isinstance(trace_call, dict) else None
    steps.append(
        _drop_none(
            {
                "step_id": len(steps) + 1,
                "timestamp": _timestamp(started_at),
                "source": "agent",
                "model_name": model or None,
                "message": text,
                "metrics": None if cache_hit and usage is None else _metrics(usage),
                "llm_call_count": 0 if cache_hit and usage is None else 1,
                "extra": {"gsd_moa_inner_call": call},
            }
        )
    )
    return steps


def _subagent_message(call: dict[str, Any], cache_hit: bool) -> str:
    role = call.get("role", "subagent")
    label = call.get("label") or call.get("id") or role
    provider = call.get("provider", "unknown-provider")
    model = call.get("model", "unknown-model")
    suffix = " (cache hit)" if cache_hit else ""
    return f"gsd-moa {role} call: {label} via {provider}/{model}{suffix}. Inner text not present in Pi JSONL diagnostics."


def _trace_for_message(
    message: dict[str, Any],
    trace_dir: Path | None,
    trace_cache: dict[str, dict[str, Any] | None],
) -> dict[str, Any] | None:
    diagnostics = _gsd_moa_diagnostics(message)
    if not isinstance(diagnostics, dict):
        return None
    trace_path = _string_or_none(diagnostics.get("tracePath"))
    if not trace_path:
        return None
    candidates = [Path(trace_path)]
    if trace_dir is not None:
        candidates.insert(0, trace_dir / Path(trace_path).name)
    for candidate in candidates:
        key = str(candidate)
        if key in trace_cache:
            return trace_cache[key]
        if not candidate.exists():
            trace_cache[key] = None
            continue
        try:
            data = json.loads(candidate.read_text())
        except (OSError, json.JSONDecodeError):
            trace_cache[key] = None
            continue
        trace_cache[key] = data if isinstance(data, dict) else None
        return trace_cache[key]
    return None


def _matching_trace_reference_call(trace: dict[str, Any] | None, diagnostic_call: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(trace, dict) or not isinstance(trace.get("referenceCalls"), list):
        return None
    calls = [call for call in trace["referenceCalls"] if isinstance(call, dict)]
    role = diagnostic_call.get("role")
    call_id = diagnostic_call.get("id")
    label = diagnostic_call.get("label")
    for call in calls:
        if call_id is not None and call.get("id") == call_id:
            return call
    for call in calls:
        if label is not None and call.get("label") == label:
            return call
    for call in calls:
        if call.get("role") == role and call.get("id") is None and call_id is None:
            return call
    for call in calls:
        if call.get("role") == role:
            return call
    return None


def _trace_call_text(trace_call: dict[str, Any] | None) -> str:
    if not isinstance(trace_call, dict):
        return ""
    for key in ("text", "cachedText", "output"):
        value = trace_call.get(key)
        if isinstance(value, str) and value:
            return value
    message = trace_call.get("message")
    if isinstance(message, dict):
        return _content_text(message.get("content"))
    return ""


def _tool_result_observation(message: dict[str, Any], last_agent_step: dict[str, Any] | None) -> dict[str, Any]:
    tool_call_id = _string_or_none(message.get("toolCallId"))
    known_call_ids = {
        call.get("tool_call_id")
        for call in (last_agent_step or {}).get("tool_calls", [])
        if isinstance(call, dict)
    }
    result = _drop_none(
        {
            "source_call_id": tool_call_id if tool_call_id in known_call_ids else None,
            "content": _content_text(message.get("content")),
            "extra": _drop_none(
                {
                    "tool_name": message.get("toolName"),
                    "is_error": message.get("isError"),
                    "pi_tool_call_id": tool_call_id,
                }
            ),
        }
    )
    return result


def _append_observation_result(step: dict[str, Any], result: dict[str, Any]) -> None:
    observation = step.setdefault("observation", {"results": []})
    observation.setdefault("results", []).append(result)


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    chunks: list[str] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        kind = part.get("type")
        if kind == "text":
            chunks.append(str(part.get("text", "")))
        elif kind == "image":
            chunks.append("[image]")
    return "".join(chunks)


def _thinking_text(content: Any) -> str:
    if not isinstance(content, list):
        return ""
    return "".join(str(part.get("thinking", "")) for part in content if isinstance(part, dict) and part.get("type") == "thinking")


def _tool_calls(content: Any) -> list[dict[str, Any]]:
    if not isinstance(content, list):
        return []
    calls: list[dict[str, Any]] = []
    for index, part in enumerate(content):
        if not isinstance(part, dict) or part.get("type") != "toolCall":
            continue
        call_id = _string_or_none(part.get("id")) or f"tool-call-{index + 1}"
        name = _string_or_none(part.get("name")) or "unknown_tool"
        arguments = part.get("arguments") if isinstance(part.get("arguments"), dict) else {}
        calls.append({"tool_call_id": call_id, "function_name": name, "arguments": arguments})
    return calls


def _gsd_moa_diagnostics(message: dict[str, Any]) -> dict[str, Any] | None:
    diagnostics = message.get("diagnostics")
    if not isinstance(diagnostics, list):
        return None
    for diagnostic in diagnostics:
        if isinstance(diagnostic, dict) and diagnostic.get("type") == "gsd-moa.details":
            details = diagnostic.get("details")
            return details if isinstance(details, dict) else None
    return None


def _llm_call_count_from_diagnostics(diagnostics: dict[str, Any] | None) -> int | None:
    if not isinstance(diagnostics, dict):
        return 1
    inner_calls = diagnostics.get("innerCalls")
    if not isinstance(inner_calls, list):
        return 1
    # Count only calls that actually hit a model. Cache hits without usage are
    # deterministic cache reads for this run.
    count = 0
    for call in inner_calls:
        if not isinstance(call, dict):
            continue
        if call.get("cacheHit") is True and "usage" not in call:
            continue
        count += 1
    return max(count, 1)


def _metrics(usage: Any) -> dict[str, Any] | None:
    if not isinstance(usage, dict):
        return None
    cost = usage.get("cost") if isinstance(usage.get("cost"), dict) else {}
    return _drop_none(
        {
            "prompt_tokens": _int_or_none(usage.get("input")),
            "completion_tokens": _int_or_none(usage.get("output")),
            "cached_tokens": _int_or_none(_number(usage.get("cacheRead")) + _number(usage.get("cacheWrite"))),
            "cost_usd": _float_or_none(cost.get("total")),
            "extra": _drop_none({"total_tokens": _int_or_none(usage.get("totalTokens"))}),
        }
    )


def _final_metrics_from_steps(steps: list[dict[str, Any]], subagents: list[dict[str, Any]]) -> dict[str, Any]:
    prompt = completion = cached = 0
    cost = 0.0
    for metrics in _iter_metrics(steps):
        prompt += int(metrics.get("prompt_tokens") or 0)
        completion += int(metrics.get("completion_tokens") or 0)
        cached += int(metrics.get("cached_tokens") or 0)
        cost += float(metrics.get("cost_usd") or 0.0)
    # Root assistant usage from gsd-moa is already combined, so do not add
    # embedded subagent metrics again. Keep subagent count in extra instead.
    return _drop_none(
        {
            "total_prompt_tokens": prompt,
            "total_completion_tokens": completion,
            "total_cached_tokens": cached,
            "total_cost_usd": cost if cost > 0 else None,
            "total_steps": len(steps),
            "extra": {"embedded_subagent_trajectory_count": len(subagents)},
        }
    )


def _iter_metrics(steps: list[dict[str, Any]]):
    for step in steps:
        metrics = step.get("metrics")
        if isinstance(metrics, dict):
            yield metrics


def _first_assistant_model(events: list[dict[str, Any]]) -> str | None:
    for event in events:
        if event.get("type") != "message_end":
            continue
        message = event.get("message")
        if isinstance(message, dict) and message.get("role") == "assistant":
            return _string_or_none(message.get("model"))
    return None


def _timestamp(value: Any) -> str | None:
    if isinstance(value, str):
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
            return value
        except ValueError:
            return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        seconds = float(value) / 1000 if value > 10_000_000_000 else float(value)
        return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.:-]+", "-", value).strip("-") or "trajectory"


def _string_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value))
        except ValueError:
            return None
    return None


def _float_or_none(value: Any) -> float | None:
    number = _number(value)
    return number if number != 0 else None


def _number(value: Any) -> float:
    if isinstance(value, bool) or value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return 0.0
    return 0.0


def _drop_none(data: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in data.items() if value is not None and value != {}}


def _jsonl_events(path: Path):
    with path.open() as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                yield event


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert Pi JSONL output to ATIF trajectory.json")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--agent-name", default="pi-gsd-moa")
    parser.add_argument("--agent-version", default="unknown")
    parser.add_argument("--model-name", default=None)
    parser.add_argument("--session", default=None, type=Path)
    parser.add_argument("--trace-dir", default=None, type=Path)
    args = parser.parse_args()

    convert_pi_jsonl_to_atif(
        args.input,
        args.output,
        agent_name=args.agent_name,
        agent_version=args.agent_version,
        model_name=args.model_name,
        session_path=args.session,
        trace_dir=args.trace_dir,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
