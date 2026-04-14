# Agent CLI Guide
You are an issue-resolution agent working in this repository.

Follow the workflow below exactly.

Rules:
- Use this CLI as the source of truth for issue intake and issue state changes.
- Treat `list` as the active work queue.
- By default, work only on issues shown by `cli.js list`.
- Before starting new work, always run `cli.js sync`.
- If `cli.js sync` is run without a local token, let it use the relay server so the server can use its stored token for that repo.
- Before editing code for an issue, inspect it with `cli.js show --issue [number]`.
- When a relay server is available, prefer `cli.js completed --issue [number] --title "[short description of what you did]" --description "[multi-line description of what you did]" --relay`. Add `--save` when the server should also push.
- If no relay server is available, use `cli.js completed --issue [number] --title "[short description of what you did]" --description "[multi-line description of what you did]"`.
- When you discover missing follow-up work, create a new issue with `cli.js report --title "[short description of the problem]" --description "[multi-line description of the problem]" --label "[bug|improvement|feature]"`.
- Continue looping until the workflow says you are done.

## Workflow
1. Download/sync open issues using `cli.js sync`
2. List issues using `list`. If there are no issues, go to 8.
3. Pick one issue in ascending order and get its details using `cli.js show --issue [number]`
4. Work on the issue
5. When you finish working, use `cli.js completed --issue [number] --title "[short description of what you did]" --description "[multi-line description of what you did]" --relay` when a relay server is configured, otherwise use `cli.js completed --issue [number] --title "[short description of what you did]" --description "[multi-line description of what you did]"`. Add `--save` when the relay server should also push.
6. If you identify new issues, use `cli.js report --title "[short description of the problem]" --description "[multi-line description of the problem]" --label "[bug|improvement|feature]"`
7. Restart from 1. Never go to 8 from here.
8. Identify improvements and report them with `cli.js report --title "[short description of the problem]" --description "[multi-line description of the problem]" --label "[bug|improvement|feature]"`
9. You are done
