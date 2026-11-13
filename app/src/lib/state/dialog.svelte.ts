/**
 * Questions asked inside the app (no `window.confirm`): a message and a few choices, shown by
 * `ui/Confirm.svelte`; `ask` resolves with the id of the choice made (Échap = the last one).
 * `askList` ajoute une liste à cocher (ex. les extraits Geofabrik à télécharger, avec leur taille).
 */
export interface Choice {
  id: string;
  label: string;
  kind?: "primary" | "danger";
}

/** Une ligne de la liste à cocher. */
export interface CheckItem {
  id: string;
  label: string;
  /** Texte à droite (taille, part de la zone…). */
  detail: string;
  checked: boolean;
}

interface Question {
  message: string;
  choices: Choice[];
  /** Liste à cocher (absente pour une simple question). */
  items?: CheckItem[];
  /** Ligne de total sous la liste, recalculée à chaque case cochée. */
  total?: (checked: string[]) => string;
  /** Le premier choix demande au moins une case cochée. */
  needsOne?: boolean;
  resolve: (id: string) => void;
}

class Dialog {
  current = $state<Question | null>(null);

  ask(message: string, choices: Choice[]): Promise<string> {
    return this.open({ message, choices }).then((r) => r.choice);
  }

  /** Question avec une liste à cocher : le choix fait et les ids cochés à ce moment. */
  askList(
    message: string,
    items: CheckItem[],
    choices: Choice[],
    total?: (checked: string[]) => string,
  ): Promise<{ choice: string; checked: string[] }> {
    return this.open({ message, choices, items, total, needsOne: true });
  }

  private open(q: Omit<Question, "resolve">): Promise<{ choice: string; checked: string[] }> {
    // A question still open is answered by its last choice (cancel) before the next one.
    this.current?.resolve(this.current.choices[this.current.choices.length - 1].id);
    return new Promise((resolve) => {
      this.current = {
        ...q,
        resolve: (id) => {
          const checked = (this.current?.items ?? []).filter((i) => i.checked).map((i) => i.id);
          this.current = null;
          resolve({ choice: id, checked });
        },
      };
    });
  }
}

export const dialog = new Dialog();
