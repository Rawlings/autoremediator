---
"autoremediator-rawlings": patch
---

The extension no longer downloads the newest `autoremediator` when a project has no copy of its own:
it runs the release it was built with. It also declares that it does not support untrusted
workspaces, since it runs the workspace's package manager and CLI.
