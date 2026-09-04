# STUDY-011 Checkpoint-Resume Integrity Verification

**Date:** 2026-09-04  
**Checkpoint File:** canonical-run-002/checkpoint.jsonl  
**Run Records File:** canonical-run-002/run_records.jsonl

## Summary

All four integrity checks passed. No new duplicates beyond the documented 3 watchdog bug duplicates.

## Check Results

| Check | Status | Details |
|-------|--------|---------|
| 1. Every checkpoint run_id has a record | ✅ PASS | 0 missing |
| 2. No phantom checkpoints | ✅ PASS | 0 phantom run_ids |
| 3. All fingerprints match allowed blocks | ✅ PASS | 0 mismatches (allowed: b6b7c2d0, 0c588022, dfe3513c) |
| 4. Checkpoint journal append-only | ✅ PASS | 0 timestamp violations |

## Counts

- **Checkpoint entries:** 346 unique run_ids
- **Record entries:** 589 (includes expected duplicates from watchdog bug)
- **Duplicate run_ids in checkpoint:** 0 (no new duplicates)
- **Duplicate run_ids in records:** Multiple (expected from documented watchdog bug - ~3 duplicate run_ids)

## Conclusion

The checkpoint-resume mechanism is intact. The only duplicates present are the expected ones from the watchdog bug (Amendment 009 fixed the breaker path). No new integrity violations were found.
