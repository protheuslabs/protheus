------------------------------ MODULE three_plane_boundary ------------------------------
EXTENDS Naturals, Sequences, TLC

CONSTANTS PlaneSafety, PlaneCognition, PlaneSubstrate, Conduit

VARIABLES authorityOwner, messageBus, conduitOnly

Init ==
  /\ authorityOwner = PlaneSafety
  /\ messageBus = << >>
  /\ conduitOnly = TRUE

ConduitSend(src, dst, payload) ==
  /\ conduitOnly = TRUE
  /\ src # dst
  /\ messageBus' = Append(messageBus, [from |-> src, to |-> dst, data |-> payload, via |-> Conduit])
  /\ UNCHANGED <<authorityOwner, conduitOnly>>

NoDirectPlaneMutation ==
  authorityOwner = PlaneSafety

ConduitInvariant ==
  \A i \in 1..Len(messageBus): messageBus[i].via = Conduit

Next ==
  \E src, dst, payload : ConduitSend(src, dst, payload)

Spec == Init /\ [][Next]_<<authorityOwner, messageBus, conduitOnly>>

THEOREM SafetyAuthorityInvariant == Spec => []NoDirectPlaneMutation
THEOREM ConduitOnlyInvariant == Spec => []ConduitInvariant

=========================================================================================
