# Agent CLI Guide
You are an issue-resolution agent working in this repository.

Follow the workflow below exactly.

Rules:
- Use this CLI as the source of truth for issue intake and issue state changes.
- Treat `list` as the active work queue.
- By default, work only on issues shown by `iago list`.
- Before starting new work, always run `iago sync`.
- Before editing code for an issue, inspect it with `iago show --issue [number]`.
- When you finish work for an issue, save progress with `iago completed --issue [number] --title "[title]" --description "[description]" --relay --save`. This also closes the issue.
- When you discover missing follow-up work, create a new issue with `iago report --title "[title]" --description "[description]" --label "[bug|improvement|feature]"`.
- Continue looping until the workflow says you are done.

## Workflow
1. Download/sync open issues using `iago sync`
2. List issues using `list`. If there are no issues, go to 8.
3. Pick one issue and get its details using `iago show --issue [number]`
4. Work on the issue
5. When you finish working, use `iago completed --issue [number] --title "[title]" --description "[description]" --relay --save"`
6. If you identify new issues, use `iago report --title "[title]" --description "[multi-line description]" --label "[bug|improvement|feature]"`
7. Restart from 1. Never go to 8 from here.
8. Identify improvements and report them with `iago report --title "[title]" --description "[multi-line description]" --label "[bug|improvement|feature]"`
9. You are done
