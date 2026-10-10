# Checklist: Requirements Traceability (031)

- [ ] US-1 daily+dedupe -> FR-002/FR-004, T006-T010; edge: double-run, disabled skip.
- [ ] US-2 weekly/monthly -> FR-002, T006-T007; edge: month-end clamp, weekday mismatch.
- [ ] US-3 card dates -> FR-006/FR-008, T013-T014; edge: bad date warns, Notion down fails open.
- [ ] US-4 subscription -30d -> FR-006, T014; edge: late catch-up once.
- [ ] US-5 reconcile D+1 -> FR-007, T015-T016; edge: no orphan nudges.
- [ ] US-6 hours + auto-done -> FR-003/FR-005, T008-T010; edge: Tasks API fail falls back to nudge.
- [ ] Config schema owned here; sibling UI consumes (C5).
- [ ] Make.io parity table filled before implementation closes (T017).
- [ ] SC-001 7-day soak + SC-002 restart (T018, quickstart.md).
