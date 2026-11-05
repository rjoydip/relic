export function cycleA(): number {
  return cycleB() + 1;
}

export function cycleB(): number {
  return cycleA() + 1;
}
