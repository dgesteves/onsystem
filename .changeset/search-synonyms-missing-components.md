---
'onsystem': patch
---

`search_components` expands words for six more components. Sheet (`offcanvas`, `slideover`), Accordion (`expandable`, `faq`), Textarea (`multiline`), Slider (`range`), Calendar (`date`, `schedule`) and Command (`palette`, `cmdk`) had no synonyms, so "a range input", "a date field" and "a command palette" searched on the query's own words alone. `picker` reached Select only; it now reaches Calendar too, which is what "date picker" asks for. An avatar is found by `profile`, `initials`, `headshot` and `gravatar`, where the entry before mapped `avatar` to itself and did nothing.

`drawer`, `collapsible` and `sidebar` stay out: each is a component of its own, and a design system that has one should rank it on its own name.
