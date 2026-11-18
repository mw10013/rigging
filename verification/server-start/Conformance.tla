---------------------------- MODULE Conformance ----------------------------
(* The model's StateOf, ListenerOf and ApplyAfter against the rows that   *)
(* conformance.ts reads from the real functions in domain.ts. A mismatch  *)
(* prints the rows that differ and fails the assumption.                  *)
EXTENDS ServerStart, CodeTables, FiniteSets, TLC

Fold(events) ==
  LET f[i \in 0..Len(events)] ==
        IF i = 0 THEN "none" ELSE ApplyAfter(f[i - 1], events[i])
  IN f[Len(events)]

StateOfDiffers ==
  {r \in StateOfRows : StateOf(r[1], r[2], r[3], r[4], r[5]) # r[6]}
ListenerOfDiffers ==
  {r \in ListenerRows : ListenerOf(r[1], r[2], r[3]) # r[4]}
ApplyAfterDiffers ==
  {r \in ApplyRows : Fold(r[1]) # r[2]}

Report(label, rows) == rows = {} \/ (PrintT(<<label, rows>>) /\ FALSE)

ASSUME Cardinality(StateOfRows) = 64 /\ Cardinality(ListenerRows) = 8
       /\ Cardinality(ApplyRows) = 121
ASSUME Report("stateOf differs from StateOf (rec, runner, group, answering, apply, code says)", StateOfDiffers)
ASSUME Report("listenerOf differs from ListenerOf (sidecar, stranger, command alive, code says)", ListenerOfDiffers)
ASSUME Report("applyOf differs from ApplyAfter (lines, code says)", ApplyAfterDiffers)
=============================================================================
