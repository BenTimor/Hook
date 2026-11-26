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
what the reader sees. A chat reply in Hook uses the same dialect: a callout, a
colour or a key in an answer draws exactly as it does on a page.

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
| a newline inside a paragraph | a line break, on its own line |

A blank line starts a new paragraph; a single newline is a line break. That is
the formatted editor's view of the text, so a paragraph written across three
lines reads as three lines — keep a paragraph on one line, and put each row of
a plain list (`1 - 5`) on its own.

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

## Math

LaTeX, as everyone already writes it. `$x^2 + y^2 = r^2$` in a sentence, and
`$$` on lines of its own for a formula that gets a line:

```markdown
The area is $\pi r^2$, so the radius is $\sqrt{A/\pi}$.

$$
\int_0^1 x^2 \, dx = \tfrac{1}{3}
$$
```

A fraction can be written the short way: `$1/2$` and `$\frac{1}{2}$` are the
same, and so are `$x^2/y$`, `$(a+b)/(c+d)$` and `$1/(2x)$`. The slash is only
read as a fraction where both sides are unambiguous — a number, a word, a group —
so `\sqrt{2}/2` is left exactly as written, and text in `\text{…}` (`\text{km/h}`)
and the arguments of `\href{…}` never change.

It renders as MathML in the read view — every surface, no stylesheet, no fonts.
The formatted editor draws it too, and turns it back into the TeX while the
caret is in the formula, because the thing you edit is the formula's source:
click a formula and it opens; type in it and you are typing TeX. A caret beside
it is not in it — on a `$$` block, the line above and the line below keep the
maths drawn. The TeX reads left to right while it is edited, in a right-to-left
document too, and a `$$` block stays a block: its lines start at the left edge
rather than flipping with the passage around it. A `$…$` that is plainly prose — a space, a word, and no TeX in it — is
left as the text it is, so "it costs $5 and the other costs $10" keeps its
dollars instead of becoming an equation. A formula that does not parse stays on the page as the TeX that was
written, in red, so nothing is ever lost silently. Math is left to right even
inside `:::rtl`, as it should be.

## Text direction

A document reads left to right unless it says otherwise. Two directives say so,
and neither one is ever drawn.

**The whole document** is a metadata line at the very top:

```markdown
::meta{direction=rtl}
# שלום

Everything below reads right to left.
```

- `rtl` for Hebrew, Arabic and similar; `ltr` for everything else.
- The line has to be the first line of the document. It is invisible in the read
  view and in the formatted editor, and the caret never lands on it.
- A document with no such line, or with `::meta{direction=ltr}`, is left to
  right. Every document written before this line existed is left to right too.

**One passage** is fenced, the way a callout is:

````markdown
An English document quoting Hebrew:

:::rtl
שלום, עולם
:::
````

- `:::rtl` … `:::` flips the lines it holds; `:::ltr` … `:::` flips them back
  inside a right-to-left document.
- A direction fence is not a box: it draws nothing of its own.
- Code is left to right wherever it sits, a fenced block inside `:::rtl`
  included.

**A chat reply** needs neither to be read right to left: it is laid out from its
own first strong character, the way the user's own messages are, so a reply
written in Hebrew reads right to left and one that opens in English does not.
The directives above still win where the text cannot say it alone — a passage
quoted in an English reply is wrapped in `:::rtl`, and a `::meta{direction=…}`
line on the top of a reply sets the whole message.

A reply's Copy button leaves the markers out: they are structure, not text, so
what is pasted is the message with its plain Markdown and no `:::rtl` fences.

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

- **A paragraph typed across lines keeps those lines.** A newline is a line
  break here, not the space Markdown prints elsewhere, so a long paragraph
  wrapped by hand reads as several short ones. Write it on one line, and use a
  blank line (or a list, or a table) to separate things.
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
- **baseRev** — on an update, the revision you read. A stale one is refused and
  the current copy comes back so the change can be re-applied.

Direction is not one of these: it is the `::meta{direction=…}` line in the text
(see Text direction), so the Markdown alone says how a document reads.

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
