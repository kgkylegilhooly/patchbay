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
