# Hook document Markdown

A Hook Workspace document, a task description and a comment are Markdown. The
text is the data: there is no rich-text copy beside it, so anything that can
read and write text can edit one, and the same words reach every surface.

Plain Markdown works as usual. On top of it Hook has one directive syntax for
the formatting Markdown has no word for — colour, highlight, underline, keys and
callout boxes. A directive is a word between a colon and brackets, `:red[text]`,
or the same word on a fenced line, `:::note[Title]`.

The formatted editor and every read view (the Workspace window, the chat side
panel, the phone sheet) parse this file with the same rules, so what you write is
what the reader sees.

**Raw HTML is never parsed.** `.md`-style HTML is not a second language here: a
document cannot contain elements, and `<u>x</u>` is shown as the text it is. Never
write `<span>`, `<u>`, `<mark>` or `<br>` and expect formatting.

## What Markdown already does

| Write | You get |
| --- | --- |
| `# Heading` to `#### Heading` | the four heading levels the toolbar writes |
| `**bold**`, `*italic*`, `~~struck~~` | bold, italic, and struck-through text |
| `` `code` `` and a fence with a language | inline code, and a code block |
| `[label](https://example.com)` | a link |
| `![alt](https://example.com/a.png)` | an image (see Images) |
| `- item`, `1. item`, `- [ ] item` | bulleted, numbered and checklist |
| `> quote` | a quote |
| `---` on its own line | a divider |
| a `\| a \| b \|` header and a `\| --- \|` row | a table |

## Colour

Wrap the words to colour:

```markdown
The invoice totals are :red[still wrong], and the copy is :green[approved].
```

- `:red[text]`, `:green[text]`, `:blue[text]`, `:purple[text]`.
- A colour inside a colour is allowed; the inner one wins where they overlap.
- Use colour for a phrase, not a paragraph. It is emphasis, not a heading.

## Highlight, underline and keys

| Write | You get |
| --- | --- |
| `:mark[text]` | a highlighter wash (also `:highlight[text]`) |
| `:underline[text]` | an underline (also `:u[text]`) |
| `:kbd[Ctrl+S]` | a key, drawn like one on a keyboard |

## Callouts

A callout is a fence whose word names the kind, a title in brackets, the body,
and a closing fence. There are four kinds:

````markdown
:::note[Before you start]
The body is ordinary Markdown: paragraphs, **bold**, lists, a table, code.
:::
````

| Kind | Use it for |
| --- | --- |
| `:::note[Title]` | something worth saying beside the text |
| `:::tip[Title]` | a shortcut, a better way |
| `:::warning[Title]` | something that will cost time if it is missed |
| `:::danger[Title]` | data loss, a destructive command, a hard mistake |

- The title is optional. `:::tip` with no brackets gets the word as its title
  ("Tip"), so `:::warning` reads as a warning without inventing one.
- A title is one line of Markdown: text, a colour, a link. It cannot wrap.
- Close the callout. An unclosed one runs to the end of the document.
- A callout can hold any block, including another callout.
- To nest, give the outer fence **one more colon** than the inner one:

````markdown
::::note[Release day]
Everything here happens together.

:::tip[Order]
Run the build first.
:::
::::
````

## Where the syntax works

- Inline rules work anywhere text does: paragraphs, headings, list items, table
  cells, quotes, and callout titles and bodies. A label holds ordinary Markdown,
  so `:red[a **b**]` colours "a b" and keeps the bold.
- A block rule works at the top level, and inside a list item or a quote when
  its lines carry the container's indent or `>` prefix. Indent two spaces under a
  `- ` bullet, three under `1. `:

````markdown
- Rebuild the site.

  :::warning[Cache]
  Clear it, or the old page stays.
  :::
````

## What stays literal

Nothing is reformatted by a typo. Each of these is shown exactly as typed:

- an unregistered word in either position: `:chart[1]`, `:::sidebar`;
- a registered word in the wrong position: `:note[x]` in a sentence, or a
  `:::red` fence;
- an empty label: `:red[]`;
- anything inside inline code or a fenced code block;
- raw HTML, and any text that merely looks like a directive: `at 10:30`,
  `localhost:8080`, `NYSE:SHEL`, `A1:A10` are untouched.

There is no backslash escape for a directive — `\:red[x]` still draws a colour.
To show the syntax as an example, put it in inline code: `` `:red[x]` ``.

## Traps

- **A colon-only line inside a fenced code block.** A line of `:::` inside a code
  sample closes the callout around it, and the rest spills out. Give the callout
  one more colon than the sample needs (`::::note` … `::::`) and it closes where
  you meant.
- **A title that wraps** is not a title: the whole fence shows up as text.
- **A half-written fence** — `:::note` with no closer — is a callout, not a typo,
  and takes the rest of the document with it.

## Images

`![alt](https://example.com/a.png)` draws an image when the address is absolute:
`https://`, `http://`, or a `data:image/png|jpeg|gif|webp;base64,…` the editor
embedded. Anything else (a path, a `file:` URL, an SVG data URL) is replaced with
the alt text, so a document can never make the window load something else.

Pictures the user drops into the editor are stored in the document as a data
URL. That is the editor's job, not yours: write an absolute address, or leave the
picture out.

## The document around the Markdown

These are properties of the document, not words in the text. Set them with the
`workspace_documents` tool:

- **title** — the name in the tree, separate from the first heading.
- **direction** — `ltr` or `rtl`, for the whole document, when the user writes
  Hebrew, Arabic or another right-to-left language. Tables, lists, quotes and
  callouts flip with it; there is no per-paragraph direction.
- **baseRev** — on an update, the revision you read. A stale one is refused and
  the current copy comes back so the change can be re-applied.

## A whole document

````markdown
# Release checklist

Everything that has to ship before **Friday**, in the order it ships.

:::warning[Before the release]
The invoice totals are :red[still wrong]. Ask Mallory about the 14th.
:::

## Copy

- [x] Pricing page
- [ ] Release notes — see :mark[the draft]

## Owners

| Step | Owner |
| --- | --- |
| Copy | :green[Mallory] |
| Pricing | :mark[Ben] |

> Run `pnpm release` once the page is :underline[approved].

```js
const steps = ["build", "sign", "publish"];
```
````
