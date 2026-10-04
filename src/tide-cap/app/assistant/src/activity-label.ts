import type { AssistantActivity } from "./AssistantController";

export function activityHeader(activity: AssistantActivity): string {
  const label = activity.tool.replaceAll("_", " ");
  const status = activity.state === "started" ? "In progress" : activity.state === "declined" ? "Declined" : activity.state === "error" ? "Failed" : "Complete";
  return `${label} · ${status}`;
}
