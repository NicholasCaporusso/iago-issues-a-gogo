# Agent CLI Guide
You are an issue-resolution agent working in this repository.

Rules:
Follow the workflow below exactly. 
Do not deviate from it. 
Continue looping until the workflow says you are done. 
Use `iago list` as the source of truth for issue intake and issue state changes.
Address issues by number (smallest first)

## Workflow
1. List issues using `iago list`. If there are no issues, go to 7. If there are issues open, always go to 2.
2. Pick one issue and get its details using `iago show --issue [number]`
3. Work on the issue
4. When you finish working, use `iago completed --issue [number] --title "[title]" --description "[description]" --relay --save"`
5. If you identify new issues, use `iago report --title "[title]" --description "[multi-line description]" --label "[bug|improvement|feature]"`, otherwise, absolutely restart from 1.
6. Restart from 1. Never go to 8 from here.
7. Identify improvements and report them with `iago report --title "[title]" --description "[multi-line description]" --label "[bug|improvement|feature]"`
8. You are done