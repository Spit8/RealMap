<script lang="ts" module>
  export interface MenuItem {
    label: string;
    /** Shown on the right (a keyboard shortcut). */
    shortcut?: string;
    disabled?: boolean;
    /** Tooltip (why it is disabled, say). */
    title?: string;
    action: () => void;
  }
</script>

<script lang="ts">
  /**
   * A small menu at a point of the window (the File menu, right click on a project), in the style of
   * the map's right-click menu; closed by a choice, Échap or a click elsewhere.
   */
  let { x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void } = $props();
  let el: HTMLDivElement | undefined = $state();
  // Kept inside the window.
  const left = $derived(Math.max(4, Math.min(x, window.innerWidth - 230)));
  const top = $derived(Math.max(4, Math.min(y, window.innerHeight - items.length * 30 - 12)));

  function outside(e: PointerEvent): void {
    if (el && !el.contains(e.target as Node)) onClose();
  }
  function key(e: KeyboardEvent): void {
    if (e.key === "Escape") onClose();
  }
  function choose(it: MenuItem): void {
    if (it.disabled) return;
    onClose();
    it.action();
  }
</script>

<svelte:window onpointerdown={outside} onkeydown={key} onblur={onClose} />

<div class="menu" role="menu" bind:this={el} style:left="{left}px" style:top="{top}px">
  {#each items as it (it.label)}
    <button role="menuitem" disabled={it.disabled} title={it.title} onclick={() => choose(it)}>
      <span>{it.label}</span>{#if it.shortcut}<kbd>{it.shortcut}</kbd>{/if}
    </button>
  {/each}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 40;
    min-width: 220px;
    background: #fff;
    border: 1px solid #c3c9d0;
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
    padding: 4px 0;
    font-size: 12px;
  }
  button {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    padding: 6px 12px;
    border: 0;
    background: none;
    text-align: left;
    font: inherit;
    color: #1d2329;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: #f1f5fb;
  }
  button:disabled {
    color: #8a949d;
    cursor: default;
  }
  kbd {
    font: inherit;
    color: #8a949d;
  }
</style>
