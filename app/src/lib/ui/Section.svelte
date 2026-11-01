<script lang="ts">
  /**
   * A panel section that folds (DECISION-015): a `<details>` whose open state is kept per `id` in
   * localStorage (per viewer convenience; works without it).
   */
  import type { Snippet } from "svelte";

  let { id, title, open = false, children }: { id: string; title: string; open?: boolean; children: Snippet } = $props();

  const KEY = "importcity.section.";
  function initial(): boolean {
    try {
      const v = localStorage.getItem(KEY + id);
      return v === null ? open : v === "1";
    } catch {
      return open;
    }
  }
  let isOpen = $state(initial());
  function toggled(e: Event): void {
    isOpen = (e.currentTarget as HTMLDetailsElement).open;
    try {
      localStorage.setItem(KEY + id, isOpen ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }
</script>

<details class="section" open={isOpen} ontoggle={toggled}>
  <summary>{title}</summary>
  <div class="content">{@render children()}</div>
</details>

<style>
  .section {
    border: 1px solid #d5d9de;
    border-radius: 6px;
    margin: 8px 0;
    padding: 0 10px;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
    padding: 7px 0;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary::before {
    content: "▸";
    color: #8a949d;
    width: 10px;
  }
  .section[open] > summary::before {
    content: "▾";
  }
  .content {
    padding-bottom: 8px;
  }
</style>
