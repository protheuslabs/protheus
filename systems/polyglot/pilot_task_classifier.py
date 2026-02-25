#!/usr/bin/env python3
import json
import re
import sys
import time


def normalize_task_type(value):
    token = str(value or '').strip().lower()
    token = re.sub(r'[^a-z0-9_.:-]+', '_', token)
    token = re.sub(r'_+', '_', token).strip('_')
    return token[:64] if token else 'unknown'


def clamp(v, lo, hi, fallback):
    try:
        n = float(v)
    except Exception:
        return fallback
    return max(lo, min(hi, n))


def compute(task_type, signals):
    s = signals if isinstance(signals, dict) else {}
    urgency = clamp(s.get('urgency', 0.5), 0.0, 1.0, 0.5)
    confidence = clamp(s.get('confidence', 0.5), 0.0, 1.0, 0.5)
    risk = clamp(s.get('risk', 0.3), 0.0, 1.0, 0.3)

    score = (confidence * 0.55) + (urgency * 0.35) - (risk * 0.2)
    score = clamp(score, 0.0, 1.0, 0.5)

    lane = 'standard'
    if score >= 0.72:
      lane = 'priority'
    elif score <= 0.36:
      lane = 'defer'

    if task_type.startswith('security') or task_type.startswith('integrity'):
      lane = 'priority'
      score = max(score, 0.78)

    return {
      'task_type': task_type,
      'score': round(score, 4),
      'recommended_lane': lane
    }


def main():
    start = time.perf_counter()
    raw = sys.stdin.read()
    if not raw:
        print(json.dumps({'ok': False, 'error': 'empty_stdin'}))
        return 2

    try:
        payload = json.loads(raw)
    except Exception:
        print(json.dumps({'ok': False, 'error': 'invalid_json'}))
        return 2

    task_type = normalize_task_type(payload.get('task_type'))
    result = compute(task_type, payload.get('signals'))
    elapsed_ms = (time.perf_counter() - start) * 1000

    out = {
        'ok': True,
        'module': 'pilot_task_classifier',
        'contract_version': '1.0',
        'result': result,
        'receipt': {
            'runtime': 'python3',
            'latency_ms': round(elapsed_ms, 3),
            'rollback_token': str(payload.get('rollback_token') or '').strip()[:128] or None
        }
    }
    print(json.dumps(out))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
