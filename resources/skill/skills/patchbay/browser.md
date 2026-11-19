# Browser nodes on the Patchbay canvas

Part of the Patchbay skill: read SKILL.md first, for what you may touch.

```sh
patchbay open-browser --url http://localhost:3000 --title "App"
patchbay browser read --node <id>
patchbay browser click --node <id> --ref e4
patchbay browser type --node <id> --ref e2 --text "hello" --clear --enter
patchbay browser scroll --node <id> --by 800
patchbay browser navigate --node <id> --url https://example.com
patchbay browser back --node <id>
patchbay browser screenshot --node <id>
patchbay browser viewport --node <id> --preset mobile
patchbay browser verify --node <id> --phase start --task-id <optional-task-id>
patchbay browser verify --node <id> --phase step
patchbay browser verify --node <id> --phase finish --outcome passed
patchbay browser console --node <id>
patchbay browser network --node <id>
patchbay browser evidence --node <id>
```

- A browser node opens only `http`, `https` and `about:blank`. Files, `javascript:` and other programs are
  refused, and so are pop-ups: a page's new window opens in the same node.
- `read` gives the page's visible text (up to 20000 characters, `--max-chars` up to 100000) and up to 200
  interactive elements, each with a `ref` such as `e4`. `click` and `type` take those refs. A ref stays the
  same while the page does, but not across a new page, so read again after anything that loads one.
- `click` presses the middle of the element as real input. If something covers it, it's refused.
- `type` types into a text field, or picks an option in a list by its value or label. The reply gives how
  many characters, never the text. `--clear` empties the field first and `--enter` presses Enter after.
- `scroll` takes one of `--by PIXELS` (negative goes up), `--to top|bottom` or `--ref` to bring an element
  into view.
- `screenshot` saves a PNG of what the node shows under Patchbay's app data and prints its `path`. Only the
  newest 50 are kept.
- Browsers you open keep their own sign-ins, apart from browsers the person opens and from their own
  Chrome. There's no verb for cookies, and none that runs scripts.
- The page only exists while its project is on screen. If it isn't, verbs are refused with a reason.
  Each call waits up to about 25 seconds.

Verification records a before picture on start, another on step, and an after picture on finish.
Actions between them are recorded automatically without typed text. Finish's `passed`, `failed` or
`unknown` is your assertion, never proof or human acceptance. The person sees the records in the
browser node's Evidence panel. Only the agent that started an attempt can add steps or finish it; one
left with no step for 10 minutes is marked abandoned. `--task-id` must name a task in the browser's
project (`patchbay task list`). The task then lists the attempt, as your claim: it never makes the
task ready.

Viewports are `desktop` (1280×800) and `mobile` (390×844) CSS pixels; mobile does not emulate a phone's
touch or user agent. Select the viewport before starting. Finish, Take control and `--preset node`
put the page back to the node's own size. Revision means the observed containing
checkout, including dirty state; the page's actual served revision is unknown.

Console errors and failed requests have page, attempt and time identifiers. A failed request shows its
HTTP status, or Chromium's error name such as net::ERR_CONNECTION_REFUSED. Console messages are
omitted because they may contain secrets. No cookies, headers, request bodies or typed values are
stored. URL credentials, query strings and fragments are removed, and so are path parts that look like
tokens. Evidence pictures hide what's typed in form fields (outlined instead) and embedded frames;
fields inside web components still show. A plain `browser screenshot` hides nothing. Visible page
content remains private evidence. Never enter secrets.

Keep the project visible while recording. Take control refuses every agent verb and interrupts the
attempt. Detaching the page or restarting also leaves an incomplete attempt. Missing pictures and
truncated logs are explicit, never treated as passing. Retention is 30 days and 100 attempts, with
200 diagnostics/actions and 20 pictures per attempt, and 2 MiB metadata. Evidence pictures have their
own folder: 128 MiB in all, 16 MiB each. Requests cancelled by the page aren't counted as failures.
