-------------------------- MODULE OperationRecovery --------------------------
(***************************************************************************)
(* One supervised operation of @xioflow/kernel: intent-first gated spawn,  *)
(* the stop pipeline, supervisor crashes at any step, and recovery.        *)
(* ARCHITECTURE §3.1 (launch), §3.2/§3.4 (recovery), §4.2 (stop), §4.2.1   *)
(* (reaper). The same invariants are exercised on the real implementation *)
(* by tests/fault/crash-matrix.test.ts.                                    *)
(*                                                                         *)
(* Persisted (SQLite):  opStatus, result, identity, lease                  *)
(* Operating system:    proc, effected                                     *)
(* Volatile:            pc (lost on crash), sup                            *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Driver,       \* "node": the tree outlives a crashed supervisor
                  \* "reaper": the helper stops the tree when the supervisor dies
    MaxCrashes    \* bound on supervisor crashes, keeps the state space finite

ASSUME Driver \in {"node", "reaper"}
ASSUME MaxCrashes \in Nat

VARIABLES
    opStatus,   \* "none" | "intent" | "active" | "stopping" | "done"
    result,     \* "none" | "succeeded" | "failed" | "cancelled" | "indeterminate"
    identity,   \* process identity persisted (OS start time recorded)
    lease,      \* exclusive resource lease persisted
    proc,       \* "none" | "gated" | "running" | "exited"
    effected,   \* the process performed its side effect
    effects,    \* how many times the side effect ran (at-most-once check)
    pc,         \* supervisor's in-memory protocol step
    sup,        \* "up" | "down"
    crashes

vars == <<opStatus, result, identity, lease, proc, effected, effects, pc, sup, crashes>>

Live == {"gated", "running"}

Init ==
    /\ opStatus = "none" /\ result = "none" /\ identity = FALSE /\ lease = FALSE
    /\ proc = "none" /\ effected = FALSE /\ effects = 0
    /\ pc = "idle" /\ sup = "up" /\ crashes = 0

(* ---------------- launch protocol (supervisor up) ---------------------- *)

\* Submitting an opId that is already recorded only replays; a fresh one registers
\* the intent and its lease in one transaction before anything runs.
Register ==
    /\ sup = "up" /\ pc = "idle" /\ opStatus = "none"
    /\ opStatus' = "intent" /\ lease' = TRUE /\ pc' = "registered"
    /\ UNCHANGED <<result, identity, proc, effected, effects, sup, crashes>>

\* The driver starts the process blocked on its gate.
Spawn ==
    /\ sup = "up" /\ pc = "registered"
    /\ proc' = "gated" /\ pc' = "spawned"
    /\ UNCHANGED <<opStatus, result, identity, lease, effected, effects, sup, crashes>>

\* Identity and "active" are persisted before the gate opens.
Activate ==
    /\ sup = "up" /\ pc = "spawned" /\ proc = "gated"
    /\ opStatus' = "active" /\ identity' = TRUE /\ pc' = "activated"
    /\ UNCHANGED <<result, lease, proc, effected, effects, sup, crashes>>

ReleaseGate ==
    /\ sup = "up" /\ pc = "activated" /\ proc = "gated"
    /\ proc' = "running" /\ pc' = "supervising"
    /\ UNCHANGED <<opStatus, result, identity, lease, effected, effects, sup, crashes>>

(* ---------------- the process itself (independent of the supervisor) --- *)

Effect ==
    /\ proc = "running" /\ ~effected
    /\ effected' = TRUE /\ effects' = effects + 1
    /\ UNCHANGED <<opStatus, result, identity, lease, proc, pc, sup, crashes>>

Exit ==
    /\ proc = "running"
    /\ proc' = "exited"
    /\ UNCHANGED <<opStatus, result, identity, lease, effected, effects, pc, sup, crashes>>

(* ---------------- completion and the stop pipeline --------------------- *)

\* Root exit observed: the result (exit code) and the lease release commit together.
RecordExit ==
    /\ sup = "up" /\ pc = "supervising" /\ opStatus = "active" /\ proc = "exited"
    /\ opStatus' = "done" /\ lease' = FALSE /\ pc' = "idle"
    /\ result' = IF effected THEN "succeeded" ELSE "failed"
    /\ UNCHANGED <<identity, proc, effected, effects, sup, crashes>>

BeginStop ==
    /\ sup = "up" /\ pc = "supervising" /\ opStatus = "active" /\ proc = "running"
    /\ opStatus' = "stopping" /\ pc' = "stopping"
    /\ UNCHANGED <<result, identity, lease, proc, effected, effects, sup, crashes>>

\* Driver confirmed the tree is gone: cancelled, lease released.
StopConfirmed ==
    /\ sup = "up" /\ pc = "stopping"
    /\ proc' = "exited"
    /\ opStatus' = "done" /\ result' = "cancelled" /\ lease' = FALSE /\ pc' = "idle"
    /\ UNCHANGED <<identity, effected, effects, sup, crashes>>

\* Driver cannot confirm: indeterminate, the lease is kept for adjudication.
StopUnconfirmed ==
    /\ sup = "up" /\ pc = "stopping"
    /\ opStatus' = "done" /\ result' = "indeterminate" /\ pc' = "idle"
    /\ UNCHANGED <<identity, lease, proc, effected, effects, sup, crashes>>

(* ---------------- crash and recovery ----------------------------------- *)

\* SIGKILL at any point: volatile state is lost. A gated process always dies
\* (its gate closes with the supervisor); the reaper also stops a running tree.
Crash ==
    /\ sup = "up" /\ crashes < MaxCrashes
    /\ sup' = "down" /\ pc' = "idle" /\ crashes' = crashes + 1
    /\ proc' = CASE proc = "gated" -> "exited"
                 [] proc = "running" /\ Driver = "reaper" -> "exited"
                 [] OTHER -> proc
    /\ UNCHANGED <<opStatus, result, identity, lease, effected, effects>>

\* Recovery handles the unfinished operation in one transaction. Identity
\* verification may be unable to decide (canDecide = FALSE), which must isolate.
RecoverWith(canDecide) ==
    /\ sup = "down"
    /\ sup' = "up" /\ pc' = "idle"
    /\ CASE opStatus = "intent" ->
                \* never activated: the gate never opened, nothing ran
                /\ opStatus' = "done" /\ result' = "failed" /\ lease' = FALSE
                /\ UNCHANGED proc
         [] opStatus \in {"active", "stopping"} /\ proc = "running" /\ canDecide ->
                \* original process confirmed alive: stop it, then release
                /\ opStatus' = "done" /\ result' = "cancelled" /\ lease' = FALSE
                /\ proc' = "exited"
         [] opStatus \in {"active", "stopping"} /\ proc = "exited" /\ canDecide ->
                \* confirmed gone: "marked_dead", exit status unknown
                /\ opStatus' = "done" /\ result' = "failed" /\ lease' = FALSE
                /\ UNCHANGED proc
         [] opStatus \in {"active", "stopping"} /\ ~canDecide ->
                /\ opStatus' = "done" /\ result' = "indeterminate"
                /\ UNCHANGED <<lease, proc>>
         [] OTHER ->
                UNCHANGED <<opStatus, result, lease, proc>>
    /\ UNCHANGED <<identity, effected, effects, crashes>>

Recover == RecoverWith(TRUE) \/ RecoverWith(FALSE)

\* The operation is settled and the supervisor idles: a terminal state, not a deadlock.
Settled ==
    /\ sup = "up" /\ pc = "idle" /\ opStatus = "done"
    /\ UNCHANGED vars

Next ==
    \/ Settled
    \/ Register \/ Spawn \/ Activate \/ ReleaseGate
    \/ Effect \/ Exit
    \/ RecordExit \/ BeginStop \/ StopConfirmed \/ StopUnconfirmed
    \/ Crash \/ Recover

Spec == Init /\ [][Next]_vars /\ WF_vars(Recover) /\ WF_vars(Exit)
        /\ WF_vars(Spawn) /\ WF_vars(Activate) /\ WF_vars(ReleaseGate)
        /\ WF_vars(RecordExit) /\ WF_vars(StopConfirmed \/ StopUnconfirmed)

(* ---------------- properties ------------------------------------------- *)

TypeOK ==
    /\ opStatus \in {"none", "intent", "active", "stopping", "done"}
    /\ result \in {"none", "succeeded", "failed", "cancelled", "indeterminate"}
    /\ proc \in {"none", "gated", "running", "exited"}
    /\ identity \in BOOLEAN /\ lease \in BOOLEAN /\ effected \in BOOLEAN
    /\ sup \in {"up", "down"}

\* No fake running: "active" is only ever persisted with an identity for a real process.
NoFakeRunning == opStatus \in {"active", "stopping"} => identity /\ proc # "none"

\* No premature release: once registered, the lease is only gone when nothing runs.
NoPrematureRelease == (opStatus # "none" /\ ~lease) => proc \notin Live

\* No blind retry: the side effect runs at most once per opId.
AtMostOnce == effects <= 1

\* No fake success.
NoFakeSuccess == result = "succeeded" => effected

\* Indeterminate is an isolation state: it keeps the lease until adjudication.
IndeterminateHoldsLease == result = "indeterminate" => lease

\* A process that never passed its gate never had an effect.
GateBeforeEffect == ~identity => ~effected

\* Done is final and always carries a result.
DoneHasResult == opStatus = "done" <=> result # "none"

\* Liveness: a submitted operation is eventually settled, and a settled operation
\* leaves no process running unless it is isolated as indeterminate.
EventuallySettled == (opStatus # "none") ~> (opStatus = "done")
NoOrphanAtRest == <>[](sup = "up" /\ opStatus = "done" => (proc \notin Live \/ result = "indeterminate"))

(***************************************************************************)
(* Known, deliberate gap (not checked): "marked_dead" records "failed" when *)
(* the process is confirmed gone but its exit status was never persisted,  *)
(* even though it may have completed its side effect. The property         *)
(*     NoFalseFailure == result = "failed" => ~effected                     *)
(* is violated by Crash after Effect/Exit followed by RecoverWith(TRUE);    *)
(* TLC produces that trace. See ROADMAP for the proposed "exited_unknown".  *)
(***************************************************************************)
=============================================================================
