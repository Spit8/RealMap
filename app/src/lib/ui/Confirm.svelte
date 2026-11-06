<script lang="ts">
  /** The question asked by `dialog.ask` (state/dialog.svelte.ts), over the whole window. */
  import { dialog } from "$lib/state/dialog.svelte";

  const q = $derived(dialog.current);
  let first: HTMLButtonElement | undefined = $state();
  $effect(() => {
    if (q) first?.focus();
  });
  function onKey(e: KeyboardEvent): void {
    if (!q || e.key !== "Escape") return;
    e.preventDefault();
    q.resolve(q.choices[q.choices.length - 1].id);
  }
</script>

<svelte:window onkeydown={onKey} />

{#if q}
  <div class="backdrop">
    <div class="box" role="alertdialog" aria-modal="true" aria-label={q.message}>
      <p>{q.message}</p>
      <div class="buttons">
        {#each q.choices as c, i (c.id)}
          {#if i === 0}
            <button bind:this={first} class={c.kind ?? ""} onclick={() => q.resolve(c.id)}>{c.label}</button>
          {:else}
            <button class={c.kind ?? ""} onclick={() => q.resolve(c.id)}>{c.label}</button>
          {/if}
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgba(29, 35, 41, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .box {
    background: #fff;
    border: 1px solid #c3c9d0;
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25);
    padding: 16px 18px 14px;
    width: min(440px, calc(100vw - 32px));
    font-size: 13px;
    color: #1d2329;
  }
  p {
    margin: 0 0 14px;
    line-height: 1.45;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }
  button {
    padding: 6px 12px;
    border-radius: 5px;
    border: 1px solid #c3c9d0;
    background: #fff;
    color: #1d2329;
    font: inherit;
    cursor: pointer;
  }
  button:hover {
    background: #f1f5fb;
  }
  button.primary {
    background: #fd9401;
    border-color: #fd9401;
    color: #fff;
    font-weight: 600;
  }
  button.primary:hover {
    background: #e58500;
  }
  button.danger {
    color: #b00020;
    border-color: #e3b3bb;
  }
</style>
