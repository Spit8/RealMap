/**
 * Questions asked inside the app (no `window.confirm`): a message and a few choices, shown by
 * `ui/Confirm.svelte`; `ask` resolves with the id of the choice made (Échap = the last one).
 */
export interface Choice {
  id: string;
  label: string;
  kind?: "primary" | "danger";
}

interface Question {
  message: string;
  choices: Choice[];
  resolve: (id: string) => void;
}

class Dialog {
  current = $state<Question | null>(null);

  ask(message: string, choices: Choice[]): Promise<string> {
    // A question still open is answered by its last choice (cancel) before the next one.
    this.current?.resolve(this.current.choices[this.current.choices.length - 1].id);
    return new Promise((resolve) => {
      this.current = {
        message,
        choices,
        resolve: (id) => {
          this.current = null;
          resolve(id);
        },
      };
    });
  }
}

export const dialog = new Dialog();
