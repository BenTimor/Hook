//! Surgical edits to a Markdown document.
//!
//! A document *is* its Markdown, and the whole of it used to travel through the
//! model on every change: a 40 KB document cost thousands of tokens to touch one
//! paragraph, and the model had to retype everything it did not mean to change.
//! This module is the other way round — one call names a section or an exact run
//! of text and only that part is rewritten.
//!
//! It is pure text: the caller reads the document, applies the ops here and
//! writes the result back with the revision it read, so the conflict question
//! stays the server's (`baseRev`) and this file has no idea about accounts.
//!
//! A *section* is a heading and the lines under it, up to the next heading of the
//! same or a higher level. Headings inside a fenced code block are code, not
//! sections, so `# comment` in a sample never splits a document in two.

use serde_json::Value;

/// One heading, its body, and where both sit in the text.
pub struct Section {
    pub level: usize,
    pub title: String,
    /// The heading path the model addresses it by: `Pricing > Cards`.
    pub path: String,
    /// Index of the heading this one sits under, if any.
    pub parent: Option<usize>,
    /// Byte offset of the heading's first character.
    pub start: usize,
    /// Byte offset just past the heading line; the body begins here.
    pub body_start: usize,
    /// Byte offset where the next heading of the same or a higher level begins,
    /// or the end of the text.
    pub end: usize,
    /// 1-based line number of the heading, for the outline the model reads.
    pub line: usize,
}

impl Section {
    pub fn body<'a>(&self, markdown: &'a str) -> &'a str {
        &markdown[self.body_start..self.end]
    }

    pub fn whole<'a>(&self, markdown: &'a str) -> &'a str {
        &markdown[self.start..self.end]
    }
}

/// Every heading in the document, in document order, nested by level.
pub fn sections(markdown: &str) -> Vec<Section> {
    let mut out: Vec<Section> = Vec::new();
    // Indices of the headings still open, shallowest first. A new heading
    // closes every open one at its own level or deeper.
    let mut open: Vec<usize> = Vec::new();
    let mut fence: Option<(u8, usize)> = None;
    let mut offset = 0usize;

    for (index, raw) in markdown.split_inclusive('\n').enumerate() {
        let content = raw.trim_end_matches('\n').trim_end_matches('\r');
        let line = content.trim_start();
        if let Some((marker, opened)) = fence {
            // A closing fence repeats the marker at least as many times and
            // carries nothing after it.
            if let Some((close, run)) = fence_run(line) {
                if close == marker && run >= opened && line[run..].trim().is_empty() {
                    fence = None;
                }
            }
        } else if let Some((marker, run)) = fence_run(line) {
            fence = Some((marker, run));
        } else if let Some((level, title)) = heading(line) {
            while let Some(&top) = open.last() {
                if out[top].level >= level {
                    out[top].end = offset;
                    open.pop();
                } else {
                    break;
                }
            }
            let parent = open.last().copied();
            let path = match parent {
                Some(parent) => format!("{} > {}", out[parent].path, title),
                None => title.to_string(),
            };
            open.push(out.len());
            out.push(Section {
                level,
                title: title.to_string(),
                path,
                parent,
                start: offset,
                body_start: offset + raw.len(),
                end: 0,
                line: index + 1,
            });
        }
        offset += raw.len();
    }
    for index in open {
        out[index].end = markdown.len();
    }
    out
}

/// The fence a line opens, when it opens one: the marker character and how many
/// of it. Three is the minimum CommonMark accepts.
fn fence_run(line: &str) -> Option<(u8, usize)> {
    let marker = *line.as_bytes().first()?;
    if marker != b'`' && marker != b'~' {
        return None;
    }
    let run = line.bytes().take_while(|byte| *byte == marker).count();
    if run < 3 {
        return None;
    }
    Some((marker, run))
}

/// The level and text of an ATX heading (`## Title`), or `None` for anything
/// else. `#hashtag` is not a heading: CommonMark wants the space.
fn heading(line: &str) -> Option<(usize, &str)> {
    let level = line.bytes().take_while(|byte| *byte == b'#').count();
    if level == 0 || level > 6 {
        return None;
    }
    let rest = &line[level..];
    if rest.is_empty() {
        return Some((level, ""));
    }
    if !rest.starts_with(' ') {
        return None;
    }
    let title = rest.trim();
    // An ATX closing sequence is a run of `#` preceded by a space, and never
    // part of the title: `## C#` keeps its sharp.
    let trimmed = title.trim_end_matches('#');
    if trimmed.len() < title.len() && trimmed.ends_with(' ') {
        return Some((level, trimmed.trim_end()));
    }
    Some((level, title))
}

/// The heading a `section` argument names: an exact path (`Pricing > Cards`), a
/// bare heading (`Cards`, anywhere it appears) or a title that itself contains a
/// `>` (tried whole first, so a heading called `Costs > Profit` still works).
///
/// `occurrence` is 1-based and picks between headings that share a name, the
/// same way `replace` refuses to guess between two matches.
pub fn resolve(sections: &[Section], spec: &str, occurrence: usize) -> Result<usize, String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err("Name the section: its heading text, or a path such as \"Pricing > Cards\".".into());
    }
    let wanted = occurrence.max(1);

    // A heading whose own text carries a `>` wins over reading it as a path.
    let literal: Vec<usize> = (0..sections.len())
        .filter(|index| same(&sections[*index].title, spec))
        .collect();
    let mut matched = if literal.is_empty() {
        descend(sections, spec)?
    } else {
        literal
    };
    if matched.is_empty() {
        return Err(no_such_section(sections, spec));
    }
    if matched.len() < wanted {
        return Err(format!(
            "There {} {} section{}, not {wanted}. {}",
            if matched.len() == 1 { "is" } else { "are" },
            matched.len(),
            if matched.len() == 1 { "" } else { "s" },
            matched
                .iter()
                .map(|index| format!("\"{}\"", sections[*index].path))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    // `sort` keeps document order, which is what occurrence counts.
    matched.sort_unstable();
    Ok(matched[wanted - 1])
}

fn descend(sections: &[Section], spec: &str) -> Result<Vec<usize>, String> {
    let parts: Vec<&str> = spec
        .split('>')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        return Err("Name the section: its heading text, or a path such as \"Pricing > Cards\".".into());
    }
    let mut current: Vec<usize> = (0..sections.len())
        .filter(|index| same(&sections[*index].title, parts[0]))
        .collect();
    if current.is_empty() {
        return Err(no_such_section(sections, parts[0]));
    }
    for part in &parts[1..] {
        let mut next: Vec<usize> = Vec::new();
        for &parent in &current {
            for (index, section) in sections.iter().enumerate() {
                if section.parent == Some(parent) && same(&section.title, part) {
                    next.push(index);
                }
            }
        }
        if next.is_empty() {
            let parent = &sections[current[0]];
            let children: Vec<String> = sections
                .iter()
                .filter(|section| section.parent == Some(current[0]))
                .map(|section| format!("\"{}\"", section.title))
                .collect();
            return Err(if children.is_empty() {
                format!("\"{}\" has nothing under it.", parent.path)
            } else {
                format!(
                    "\"{}\" has no section \"{part}\". Under it: {}.",
                    parent.path,
                    children.join(", ")
                )
            });
        }
        current = next;
    }
    Ok(current)
}

/// What the model reads when it named something that is not there: the headings
/// it could have meant, so the next call is a correction rather than a guess.
fn no_such_section(sections: &[Section], spec: &str) -> String {
    let mut names: Vec<String> = sections
        .iter()
        .filter(|section| section.parent.is_none())
        .map(|section| format!("\"{}\"", section.title))
        .collect();
    if names.is_empty() {
        names = sections
            .iter()
            .map(|section| format!("\"{}\"", section.path))
            .collect();
    }
    if names.is_empty() {
        return format!("No section \"{spec}\": this document has no headings.");
    }
    let total = names.len();
    names.truncate(12);
    format!(
        "No section \"{spec}\". This document has: {}{}.",
        names.join(", "),
        if total > 12 { ", …" } else { "" }
    )
}

fn same(left: &str, right: &str) -> bool {
    left.trim().eq_ignore_ascii_case(right.trim())
}

/// Apply a list of ops in order. The line endings of the document and of every
/// payload are normalised to `\n` first, so a document pasted from Word is not
/// a document whose `find` never matches.
pub fn apply_all(markdown: &str, edits: &[Value]) -> Result<(String, Vec<String>), String> {
    if edits.is_empty() {
        return Err("Send at least one edit.".into());
    }
    let mut text = normalize(markdown);
    let mut applied = Vec::with_capacity(edits.len());
    let before = callout_balance(&text);
    for (index, op) in edits.iter().enumerate() {
        let (next, summary) = apply(&text, op).map_err(|error| {
            if index == 0 {
                error
            } else {
                // Say which op refused, so a five-op call is not a guessing game.
                format!("Edit {} of {}: {error}", index + 1, edits.len())
            }
        })?;
        text = next;
        applied.push(summary);
    }
    // A callout is a block that swallows everything after it when it is never
    // closed, so an edit that would unbalance one is refused rather than
    // written. A document that was already unbalanced is left alone.
    if before == 0 && callout_balance(&text) != 0 {
        return Err("That edit would leave a callout unclosed (`:::note[… ]` without its `:::`). Change the range so the block stays whole.".into());
    }
    Ok((text, applied))
}

/// One op: the new text, and the line the model gets back for it. The input's
/// line endings are normalised first, so this is safe to call on whatever the
/// server stored.
pub fn apply(markdown: &str, op: &Value) -> Result<(String, String), String> {
    let text = normalize(markdown);
    dispatch(&text, op)
}

fn dispatch(markdown: &str, op: &Value) -> Result<(String, String), String> {
    let kind = op
        .get("op")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    match kind {
        "replace" => replace(markdown, op),
        "replace_section" => replace_section(markdown, op),
        "insert_after_section" => insert(markdown, op, true),
        "insert_before_section" => insert(markdown, op, false),
        "delete_section" => delete_section(markdown, op),
        "append" => append(markdown, op),
        "" => Err("Every edit needs an \"op\": replace, replace_section, insert_after_section, insert_before_section, delete_section or append.".into()),
        other => Err(format!(
            "Unknown op \"{other}\". Use replace, replace_section, insert_after_section, insert_before_section, delete_section or append."
        )),
    }
}

fn replace(markdown: &str, op: &Value) -> Result<(String, String), String> {
    let find = op.get("find").and_then(Value::as_str).map(normalize).unwrap_or_default();
    if find.trim().is_empty() {
        return Err("\"find\" is empty. Give the exact text to look for, copied from the document.".into());
    }
    let with = op.get("replace").and_then(Value::as_str).map(normalize).unwrap_or_default();
    let all = op.get("all").and_then(Value::as_bool).unwrap_or(false);
    let hits = markdown.matches(&find).count();
    if hits == 0 {
        return Err(format!(
            "That text is not in the document. \"find\" must match exactly, spaces and line breaks included — read the section first and copy it. Looked for: {}",
            excerpt(&find)
        ));
    }
    if hits > 1 && !all {
        return Err(format!(
            "That text appears {hits} times. Include more of the surrounding text so it is unique, or add \"all\": true to change every one."
        ));
    }
    let text = if all {
        markdown.replace(&find, &with)
    } else {
        markdown.replacen(&find, &with, 1)
    };
    Ok((
        text,
        if all {
            format!("replaced all {hits} matches")
        } else {
            "replaced 1 match".to_string()
        },
    ))
}

fn replace_section(markdown: &str, op: &Value) -> Result<(String, String), String> {
    let spec = section_spec(op)?;
    let body = op
        .get("markdown")
        .and_then(Value::as_str)
        .map(normalize)
        .unwrap_or_default();
    let found = sections(markdown);
    let index = resolve(&found, &spec, occurrence(op))?;
    let section = &found[index];

    // The heading line is kept byte for byte: a new Markdown payload can carry
    // its own `### ` subheadings, so the section grows children or loses them,
    // but its own name stays what the reader sees.
    let mut replacement = markdown[section.start..section.body_start].to_string();
    if !replacement.ends_with('\n') {
        replacement.push('\n');
    }
    let body = body.trim_end();
    if !body.is_empty() {
        replacement.push('\n');
        replacement.push_str(body);
        replacement.push('\n');
    }
    if section.end < markdown.len() {
        replacement.push('\n');
    }
    let lines_before = section.body(markdown).lines().count();
    let text = splice(markdown, section.start, section.end, &replacement);
    let lines_after = sections(&text)
        .iter()
        .find(|candidate| candidate.start == section.start)
        .map(|candidate| candidate.body(&text).lines().count())
        .unwrap_or(lines_before);
    Ok((
        text,
        format!(
            "replaced the body of \"{}\" ({lines_before} → {lines_after} lines)",
            section.path
        ),
    ))
}

fn insert(markdown: &str, op: &Value, after: bool) -> Result<(String, String), String> {
    let spec = section_spec(op)?;
    let body = op
        .get("markdown")
        .and_then(Value::as_str)
        .map(normalize)
        .unwrap_or_default();
    let body = body.trim();
    if body.is_empty() {
        return Err(format!(
            "\"markdown\" is empty. Give the block to {}.",
            if after { "insert after the section" } else { "insert before the section" }
        ));
    }
    let found = sections(markdown);
    let index = resolve(&found, &spec, occurrence(op))?;
    let section = &found[index];
    let at = if after { section.end } else { section.start };

    let mut block = String::new();
    let head = &markdown[..at];
    // A block starts one blank line after whatever came before it.
    if after && !head.is_empty() && !head.ends_with("\n\n") {
        block.push('\n');
        if !head.ends_with('\n') {
            block.push('\n');
        }
    }
    block.push_str(body);
    block.push('\n');
    if at < markdown.len() {
        block.push('\n');
    }
    let text = splice(markdown, at, at, &block);
    let lines = body.lines().count();
    Ok((
        text,
        format!(
            "inserted {lines} line{} {} \"{}\"",
            if lines == 1 { "" } else { "s" },
            if after { "after" } else { "before" },
            section.path
        ),
    ))
}

fn delete_section(markdown: &str, op: &Value) -> Result<(String, String), String> {
    let spec = section_spec(op)?;
    let found = sections(markdown);
    let index = resolve(&found, &spec, occurrence(op))?;
    let section = &found[index];
    let mut text = splice(markdown, section.start, section.end, "");
    // A section that was last leaves its blank line behind; one trailing
    // newline is what a Markdown file ends with, no more.
    while text.len() > 1 && text.ends_with("\n\n") {
        text.pop();
        if text == "\n" {
            text.clear();
        }
    }
    Ok((
        text,
        format!("deleted \"{}\" and its body", section.path),
    ))
}

fn append(markdown: &str, op: &Value) -> Result<(String, String), String> {
    let body = op
        .get("markdown")
        .and_then(Value::as_str)
        .map(normalize)
        .unwrap_or_default();
    let body = body.trim();
    if body.is_empty() {
        return Err("\"markdown\" is empty. Give the block to add.".into());
    }
    let mut text = markdown.trim_end().to_string();
    if !text.is_empty() {
        text.push_str("\n\n");
    }
    text.push_str(body);
    text.push('\n');
    let lines = body.lines().count();
    Ok((
        text,
        format!("appended {lines} line{}", if lines == 1 { "" } else { "s" }),
    ))
}

fn section_spec(op: &Value) -> Result<String, String> {
    op.get("section")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            "\"section\" is empty. Give the heading text, or a path such as \"Pricing > Cards\"."
                .to_string()
        })
}

fn occurrence(op: &Value) -> usize {
    op.get("occurrence")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .map(|value| value as usize)
        .unwrap_or(1)
}

fn splice(markdown: &str, start: usize, end: usize, with: &str) -> String {
    let mut text = String::with_capacity(markdown.len() + with.len());
    text.push_str(&markdown[..start]);
    text.push_str(with);
    text.push_str(&markdown[end..]);
    text
}

/// The text as Markdown is stored: one newline per line.
pub fn normalize(text: &str) -> String {
    if text.contains('\r') {
        text.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        text.to_string()
    }
}

/// How many callout blocks are left open. A `:::note[…]` is closed by a line of
/// the same number of colons; nesting adds one colon per level.
pub fn callout_balance(markdown: &str) -> i32 {
    let mut open: Vec<usize> = Vec::new();
    let mut broken = 0usize;
    let mut fence: Option<(u8, usize)> = None;
    for raw in markdown.split_inclusive('\n') {
        let content = raw.trim_end_matches('\n').trim_end_matches('\r');
        let line = content.trim_start();
        if let Some((marker, opened)) = fence {
            if let Some((close, run)) = fence_run(line) {
                if close == marker && run >= opened && line[run..].trim().is_empty() {
                    fence = None;
                }
            }
            continue;
        }
        if let Some((marker, run)) = fence_run(line) {
            fence = Some((marker, run));
            continue;
        }
        let colons = line.bytes().take_while(|byte| *byte == b':').count();
        if colons < 3 {
            continue;
        }
        let rest = &line[colons..];
        if rest.trim().is_empty() {
            if open.last() == Some(&colons) {
                open.pop();
            } else {
                broken += 1;
            }
        } else if rest.chars().next().is_some_and(|letter| letter.is_alphabetic()) {
            open.push(colons);
        }
    }
    open.len() as i32 + broken as i32
}

fn excerpt(text: &str) -> String {
    let flat: String = text
        .chars()
        .map(|character| if character == '\n' { '⏎' } else { character })
        .collect();
    let flat = flat.trim();
    if flat.chars().count() <= 120 {
        return flat.to_string();
    }
    let short: String = flat.chars().take(117).collect();
    format!("{short}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DOC: &str = "# Release\n\nIntro.\n\n## Pricing\n\nThe price is 10.\n\n### Cards\n\nCard copy.\n\n## Changelog\n\n- first\n";

    #[test]
    fn a_section_ends_at_the_next_heading_of_its_own_level() {
        let found = sections(DOC);
        let paths: Vec<&str> = found.iter().map(|section| section.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["Release", "Release > Pricing", "Release > Pricing > Cards", "Release > Changelog"]
        );
        let pricing = &found[1];
        assert_eq!(pricing.body(DOC).trim(), "The price is 10.\n\n### Cards\n\nCard copy.");
        // The next sibling ends it, not the child.
        assert_eq!(pricing.whole(DOC).trim_end(), "## Pricing\n\nThe price is 10.\n\n### Cards\n\nCard copy.");
        assert_eq!(found[3].line, 13);
    }

    #[test]
    fn a_heading_inside_a_code_fence_is_code() {
        let doc = "## Code\n\n```\n## not a heading\n```\n\n## Real\n\ntext\n";
        let paths: Vec<String> = sections(doc).iter().map(|s| s.path.clone()).collect();
        assert_eq!(paths, vec!["Code", "Real"]);
        // Tildes too, and a fence that is never closed swallows the rest.
        let tilde = "## A\n\n~~~md\n## hidden\n~~~\n\n## B\n";
        assert_eq!(sections(tilde).len(), 2);
        assert_eq!(sections("## A\n\n```\n## B\n").len(), 1);
    }

    #[test]
    fn a_hash_without_a_space_is_not_a_heading() {
        let found = sections("#hashtag\n\n## Real\n");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "Real");
        // A closing sequence is not part of the title, a trailing sharp is.
        assert_eq!(sections("## Title ##\n")[0].title, "Title");
        assert_eq!(sections("## C#\n")[0].title, "C#");
    }

    #[test]
    fn a_section_is_found_by_title_or_by_path() {
        let found = sections(DOC);
        assert_eq!(found[resolve(&found, "Pricing", 1).unwrap()].title, "Pricing");
        // A bare child name works, because the path is only a convenience.
        assert_eq!(found[resolve(&found, "Cards", 1).unwrap()].title, "Cards");
        assert_eq!(
            found[resolve(&found, "Release > Pricing > Cards", 1).unwrap()].title,
            "Cards"
        );
        // A heading whose own text carries a `>` is matched whole first.
        let arrow = sections("## Costs > Profit\n\ntext\n");
        assert_eq!(arrow[resolve(&arrow, "Costs > Profit", 1).unwrap()].title, "Costs > Profit");
    }

    #[test]
    fn a_missing_section_says_what_is_there() {
        let found = sections(DOC);
        let error = resolve(&found, "Pricin", 1).unwrap_err();
        assert!(error.contains("This document has: \"Release\""));
        let nested = resolve(&found, "Pricing > Carbs", 1).unwrap_err();
        assert!(nested.contains("has no section \"Carbs\""));
        assert!(nested.contains("\"Cards\""));
    }

    #[test]
    fn occurrence_picks_between_headings_that_share_a_name() {
        let found = sections("## Notes\n\none\n\n## Notes\n\ntwo\n");
        assert_eq!(found[resolve(&found, "Notes", 1).unwrap()].body("## Notes\n\none\n\n## Notes\n\ntwo\n").trim(), "one");
        assert_eq!(found[resolve(&found, "Notes", 2).unwrap()].start, 15);
        assert!(resolve(&found, "Notes", 3).is_err());
    }

    #[test]
    fn replace_insists_on_an_exact_unique_match() {
        let doc = "The price is 10.\n";
        assert!(apply(doc, &json!({ "op": "replace", "find": "price is 11", "replace": "x" })).is_err());
        assert_eq!(
            apply(doc, &json!({ "op": "replace", "find": "10", "replace": "12" })).unwrap().0,
            "The price is 12.\n"
        );
        let twice = "a 1 b 1 c\n";
        let error = apply(twice, &json!({ "op": "replace", "find": "1", "replace": "2" })).unwrap_err();
        assert!(error.contains("appears 2 times"));
        assert_eq!(
            apply(twice, &json!({ "op": "replace", "find": "1", "replace": "2", "all": true })).unwrap().0,
            "a 2 b 2 c\n"
        );
    }

    #[test]
    fn replace_section_keeps_the_heading_and_the_neighbours() {
        let (text, summary) = apply(
            DOC,
            &json!({ "op": "replace_section", "section": "Pricing", "markdown": "The price is 12." }),
        )
        .unwrap();
        assert!(text.contains("## Pricing\n\nThe price is 12.\n\n## Changelog"));
        assert!(!text.contains("### Cards"), "the child was inside the replaced body");
        assert!(text.contains("# Release") && text.contains("- first"), "the rest is untouched");
        assert!(summary.contains("replaced the body of \"Release > Pricing\""));
    }

    #[test]
    fn replace_section_can_grow_children() {
        let (text, _) = apply(
            DOC,
            &json!({
                "op": "replace_section",
                "section": "Pricing",
                "markdown": "New intro.\n\n### Rows\n\nA table."
            }),
        )
        .unwrap();
        assert!(text.contains("## Pricing\n\nNew intro.\n\n### Rows\n\nA table.\n\n## Changelog"));
    }

    #[test]
    fn delete_section_takes_its_heading_and_leaves_one_blank_line() {
        let (text, summary) = apply(DOC, &json!({ "op": "delete_section", "section": "Changelog" })).unwrap();
        assert!(text.ends_with("Card copy.\n"));
        assert!(!text.contains("Changelog") && !text.contains("- first"));
        assert!(summary.contains("deleted \"Release > Changelog\""));

        let (all, _) = apply("## Only\n\ntext\n", &json!({ "op": "delete_section", "section": "Only" })).unwrap();
        assert_eq!(all, "");
    }

    #[test]
    fn insert_lands_on_the_right_side_of_the_heading() {
        let (text, _) = apply(
            DOC,
            &json!({ "op": "insert_after_section", "section": "Pricing", "markdown": "## FAQ\n\nQ." }),
        )
        .unwrap();
        assert!(text.contains("Card copy.\n\n## FAQ\n\nQ.\n\n## Changelog"), "{text}");

        let (before, _) = apply(
            DOC,
            &json!({ "op": "insert_before_section", "section": "Changelog", "markdown": "## FAQ\n\nQ." }),
        )
        .unwrap();
        assert!(before.contains("Card copy.\n\n## FAQ\n\nQ.\n\n## Changelog"), "{before}");
    }

    #[test]
    fn append_reaches_the_end_of_the_document() {
        let (text, _) = apply("## A\n\nx\n", &json!({ "op": "append", "markdown": "## B\n\ny" })).unwrap();
        assert_eq!(text, "## A\n\nx\n\n## B\n\ny\n");
        assert!(apply("## A\n", &json!({ "op": "append", "markdown": "  " })).is_err());
    }

    #[test]
    fn a_windows_document_is_edited_as_if_it_were_unix() {
        let doc = "## Pricing\r\n\r\nThe price is 10.\r\n";
        let (text, _) = apply(doc, &json!({ "op": "replace", "find": "is 10", "replace": "is 12" })).unwrap();
        assert_eq!(text, "## Pricing\n\nThe price is 12.\n");
    }

    #[test]
    fn an_edit_that_would_unclose_a_callout_is_refused() {
        let doc = "## A\n\n:::note[Heads up]\n\nbody\n\n:::\n\n## B\n\ntext\n";
        // Deleting the closing fence's section is fine; the guard is about the
        // block itself.
        let (kept, _) = apply_all(doc, &[json!({ "op": "replace", "find": "body", "replace": "new body" })]).unwrap();
        assert!(kept.contains(":::note[Heads up]\n\nnew body\n\n:::"));

        let broken = apply_all(doc, &[json!({ "op": "replace", "find": ":::\n\n## B", "replace": "\n## B" })]);
        assert!(broken.is_err());
        assert!(broken.unwrap_err().contains("callout"));
    }

    #[test]
    fn the_ops_run_in_order_and_name_the_one_that_failed() {
        let (text, applied) = apply_all(
            "# Doc\n\n## A\n\none\n",
            &[
                json!({ "op": "replace_section", "section": "A", "markdown": "two" }),
                json!({ "op": "append", "markdown": "## B\n\nthree" }),
            ],
        )
        .unwrap();
        assert_eq!(text, "# Doc\n\n## A\n\ntwo\n\n## B\n\nthree\n");
        assert_eq!(applied.len(), 2);

        let error = apply_all(
            "# Doc\n\n## A\n\none\n",
            &[
                json!({ "op": "replace", "find": "one", "replace": "two" }),
                json!({ "op": "replace", "find": "nope", "replace": "x" }),
            ],
        )
        .unwrap_err();
        assert!(error.starts_with("Edit 2 of 2:"), "{error}");
    }

    #[test]
    fn a_blank_document_is_a_document() {
        assert!(apply_all("", &[json!({ "op": "replace", "find": "x", "replace": "y" })]).is_err());
        let (text, _) = apply_all("", &[json!({ "op": "append", "markdown": "# New" })]).unwrap();
        assert_eq!(text, "# New\n");
        assert_eq!(sections("").len(), 0);
    }
}
