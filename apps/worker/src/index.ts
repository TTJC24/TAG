export const workerApplication = {
  name: "operating-layer-worker",
  status: "phase1-issue-intake",
  deliverySemantics: "at-least-once",
  retryAuthority: "postgresql",
} as const;
