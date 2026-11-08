# Process and signal behavior

CI runs the complete Node 26 suite on Ubuntu and Windows. Process-tree integration tests create a real child and descendant and verify that shutdown removes both. Workspace tests also cover coordinated shutdown and the case where one watcher fails while siblings are active.

## POSIX

Test workers and workspace watchers start in isolated process groups. `SIGINT` and `SIGTERM` are forwarded to the group, preserve the previous dependency cache, remove temporary output and edge files, and exit with conventional codes 130 and 143. A second interrupt, or the two-second shutdown deadline, escalates to `SIGKILL`.

## Windows

Node cannot reliably deliver graceful POSIX signals to an independently spawned Windows process. Tree shutdown therefore uses the system `taskkill /t /f` command and may report an operating-system-derived exit status instead of 130 or 143. Interactive Ctrl+C can still reach Node's `SIGINT` handler when the console delivers it, but automated cleanup does not depend on that behavior.

Forced termination removes the selected process and descendants. Cache replacement is atomic, so termination before a successful run completes leaves the previous cache in place. An operating-system-level forced kill cannot run application cleanup handlers, so a secure spill directory may remain for normal temporary-directory scavenging; graceful shutdown removes it immediately. The Windows CI job exercises tree cleanup, forced cache preservation, sibling watcher failure, and the rest of the platform-neutral suite; graceful signal-code assertions run only on POSIX.

Spill files request mode `0600` on POSIX. Windows does not expose POSIX mode bits, so protection follows the ACL of the user's temporary directory.

## Runtime edge batching

Each test worker records runtime dependency edges in deterministic discovery order and flushes them synchronously in batches of at most 64 KiB. A final synchronous flush runs during normal process exit, reducing filesystem writes without changing the JSON-lines format consumed on POSIX and Windows.

An operating-system-level forced termination may discard the current worker's unflushed batch. This is conservative: a failed or interrupted run never replaces the previous dependency graph, so partial runtime evidence cannot become the committed cache. The next successful run records and atomically applies a complete result.
