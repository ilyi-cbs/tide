/** Feature-owned lifecycle reactions avoid kernel imports of feature modules. */
export type ActionTransition = { ID: string; kind: string; status: string; resolution?: string };

const listeners: Array<(transition: ActionTransition) => Promise<void>> = [];

export function registerActionTransition(listener: (transition: ActionTransition) => Promise<void>) {
  listeners.push(listener);
}

export async function notifyActionTransition(transition: ActionTransition) {
  for (const listener of listeners) await listener(transition);
}
