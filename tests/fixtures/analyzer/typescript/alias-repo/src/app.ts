// @ts-nocheck
import { greet } from "@/util";
import { config } from "@shared/config";
import { libGreeting } from "@fixture/lib";
import { double } from "@fixture/lib/math";

export function run(): string {
  return `${greet(config.name)} ${libGreeting()} ${double(2)}`;
}
