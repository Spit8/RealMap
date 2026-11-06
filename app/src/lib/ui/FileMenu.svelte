<script lang="ts" module>
  import { importer } from "$lib/state/importer.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import type { MenuItem } from "./ContextMenu.svelte";

  /**
   * The project commands (File menu, right click on a project): Save, Save as, Close for `id`, plus
   * New and Open in the File menu. Nothing while a computation runs.
   */
  export function projectItems(id: string | undefined, withOpen: boolean): MenuItem[] {
    const busy = !!importer.running;
    const title = busy ? t("file.busy") : undefined;
    const run = (fn: () => Promise<unknown> | void) => () => void fn();
    const items: MenuItem[] = [];
    if (withOpen) {
      items.push({ label: t("file.new"), shortcut: "Ctrl+N", disabled: busy, title, action: run(() => importer.newProject()) });
      items.push({ label: t("file.open"), shortcut: "Ctrl+O", disabled: busy, title, action: run(() => importer.openProject()) });
    }
    items.push({ label: t("file.save"), shortcut: withOpen ? "Ctrl+S" : undefined, disabled: busy, title, action: run(() => importer.saveProject(id)) });
    items.push({ label: t("file.saveAs"), shortcut: withOpen ? "Ctrl+Maj+S" : undefined, disabled: busy, title, action: run(() => importer.saveProjectAs(id)) });
    items.push({ label: t("file.close"), shortcut: withOpen ? "Ctrl+W" : undefined, disabled: busy, title, action: run(() => importer.closeProject(id)) });
    return items;
  }
</script>

<script lang="ts">
  /** « Fichier ▾ » in the header: New, Open, Save, Save as, Close (the active project). */
  import ContextMenu from "./ContextMenu.svelte";

  let menu = $state<{ x: number; y: number } | null>(null);
  function toggle(e: MouseEvent): void {
    if (menu) {
      menu = null;
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu = { x: r.left, y: r.bottom + 2 };
  }
</script>

<!-- pointerdown kept here: the menu's « click elsewhere » must not reopen it at once. -->
<button class="file" class:open={!!menu} onpointerdown={(e) => e.stopPropagation()} onclick={toggle}>{t("file.menu")} ▾</button>
{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={projectItems(undefined, true)} onClose={() => (menu = null)} />
{/if}

<style>
  .file {
    border: 1px solid #c3c9d0;
    background: #fff;
    border-radius: 5px;
    padding: 3px 9px;
    font-size: 12px;
    color: #1d2329;
    cursor: pointer;
  }
  .file:hover,
  .file.open {
    background: #f1f5fb;
  }
</style>
