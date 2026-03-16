---
layout: home

hero:
  name: nav
  text: Edit code. Not files.
  tagline: A minimalist coding agent that references lines by hash anchors instead of reproducing entire files. Fast, precise, conflict-free.
  image:
    src: /nav.png
    alt: nav mascot — a friendly robot that breaks plans into tasks
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/sandst1/nav

features:
  - icon:
      src: /icons/hash.svg
    title: Hashline editing
    details: Lines are tracked by content hashes. Edits reference LINE:HASH anchors — if the file changed, mismatches are caught and retried automatically.
  - icon:
      src: /icons/zap.svg
    title: Built for Bun
    details: Native Bun APIs for file I/O, process spawning, and hashing. Single-binary builds for every platform. No Node.js required.
  - icon:
      src: /icons/layers.svg
    title: Multi-provider
    details: Works with OpenAI, Anthropic, Google Gemini, Azure OpenAI, Ollama, LM Studio, and OpenRouter. Cloud or fully local.
  - icon:
      src: /icons/list-tree.svg
    title: Plans & tasks
    details: Discuss an idea, save a plan, split it into ordered tasks, then work through them one by one. Persistent across sessions.
  - icon:
      src: /icons/shield.svg
    title: Sandboxing
    details: macOS Seatbelt integration restricts file writes to the project directory. Reads and network stay unrestricted.
  - icon:
      src: /icons/terminal.svg
    title: Shell & tools
    details: Seven focused tools — read, edit, write, skim, filegrep, shell, shell_status. Background process management built in.
---

<style>
.how-it-works {
  max-width: 688px;
  margin: 4rem auto;
  padding: 0 24px;
}

.how-it-works h2 {
  text-align: center;
  font-size: 1.6rem;
  margin-bottom: 0.5rem;
}

.how-it-works .subtitle {
  text-align: center;
  color: var(--vp-c-text-2);
  margin-bottom: 2rem;
}

.flow {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.flow-step {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 1.25rem;
  background: var(--vp-c-bg-soft);
}

.flow-step h3 {
  margin: 0 0 0.5rem 0;
  font-size: 1rem;
}

.flow-step p {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
  line-height: 1.5;
}

.flow-step code {
  font-size: 0.85rem;
}

.flow-arrow {
  text-align: center;
  color: var(--vp-c-text-3);
  font-size: 1.2rem;
}

.highlights-section {
  max-width: 900px;
  margin: 2rem auto 4rem;
  padding: 0 24px;
}

.highlights-section h2 {
  text-align: center;
  font-size: 1.6rem;
  margin-bottom: 2rem;
}

.highlight-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1rem;
}

.highlight-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 1.25rem;
  background: var(--vp-c-bg-soft);
  text-decoration: none;
  color: inherit;
  transition: border-color 0.2s;
}

.highlight-card:hover {
  border-color: var(--vp-c-brand-1);
}

.highlight-card h3 {
  margin: 0 0 0.5rem 0;
  font-size: 1rem;
}

.highlight-card p {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
  line-height: 1.5;
}
</style>

<div class="how-it-works">

## How it works

<p class="subtitle">Hashline editing prevents conflicts by tracking content, not line numbers.</p>

<div class="flow">

<div class="flow-step">

### 1. Read

nav reads files with hashline-prefixed output. Each line gets a short content hash.

```
42:a3|const foo = "bar";
43:f1|const baz = 42;
```

</div>

<div class="flow-arrow">v</div>

<div class="flow-step">

### 2. Edit

Edits reference `LINE:HASH` anchors instead of reproducing old content. The model says *what to change*, not *what the file looks like*.

```
edit lines 42:a3-43:f1 with:
  const foo = "updated";
  const baz = 99;
```

</div>

<div class="flow-arrow">v</div>

<div class="flow-step">

### 3. Verify

If the file changed between read and edit, hashes won't match. The edit is rejected with corrected anchors — the model retries without re-reading the entire file.

</div>

</div>

</div>

<div class="highlights-section">

## Why nav?

<div class="highlight-cards">

<a class="highlight-card" href="./guide/configuration#providers">
<h3>Any LLM, any provider</h3>
<p>Cloud APIs, local Ollama, Azure deployments, or OpenRouter. Auto-detected from model name.</p>
</a>

<a class="highlight-card" href="./guide/plans-and-tasks">
<h3>Plan, split, execute</h3>
<p>Discuss ideas interactively, save plans, split into tasks, then run them sequentially or pick your own order.</p>
</a>

<a class="highlight-card" href="./concepts/handover">
<h3>Context-aware handover</h3>
<p>When context gets long, nav summarizes progress and continues in a fresh window. Automatic or manual.</p>
</a>

</div>

</div>
