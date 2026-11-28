import { describe, it, expect } from "vitest";
import {
  animalsOnly,
  fallbackPlan,
  parsePlan,
  secondsFromPrompt,
  shotCount,
  shotNegative,
  shotPrompt,
  shotSize,
  subjectOf,
  writePlan
} from "@/lib/video/shots";

const COMBAT = "make a 30 second video of a cat and a dog (realistic) in heavy combat gear";

describe("long /video clips: shots", () => {
  it("reads the length out of the prompt", () => {
    expect(secondsFromPrompt(COMBAT)).toBe(30);
    expect(secondsFromPrompt("a 1 minute clip")).toBe(60);
    expect(secondsFromPrompt("15s of rain")).toBe(15);
    expect(secondsFromPrompt("a 2 second loop")).toBe(5);
    expect(secondsFromPrompt("a dog on a beach")).toBeNull();
  });

  it("strips the request wrapper but keeps the subject's own words", () => {
    expect(subjectOf(COMBAT)).toBe("a cat and a dog (realistic) in heavy combat gear");
    expect(subjectOf("a paper boat on a pond")).toBe("a paper boat on a pond");
    expect(subjectOf("create a video of the ocean")).toBe("the ocean");
    expect(subjectOf("a 15s clip showing rain")).toBe("rain");
  });

  it("knows when every subject is an animal", () => {
    expect(animalsOnly(COMBAT)).toBe(true);
    expect(animalsOnly("a man walking his dog")).toBe(false);
    expect(animalsOnly("a lighthouse")).toBe(false);
  });

  it("cuts 5 s shots, capped at 12", () => {
    expect(shotCount(30, "wan2.2-ti2v-5b")).toBe(6);
    expect(shotCount(60, "wan2.2-ti2v-5b")).toBe(12);
    expect(shotCount(30, "wan2.1-t2v-1.3b")).toBe(1);
    expect(shotSize(false, {})).toEqual({ width: 832, height: 480 });
    expect(shotSize(true, {})).toEqual({ width: 480, height: 832 });
  });

  it("every shot restates the subjects and rules out people for animals (the soldier-with-a-dog bug)", () => {
    const subject = subjectOf(COMBAT);
    const plan = fallbackPlan({ subject, shots: 6 });
    for (let i = 0; i < 6; i++) {
      const p = shotPrompt(plan, i, { subject });
      expect(p.startsWith("a cat and a dog (realistic) in heavy combat gear (real animals, not people)")).toBe(true);
      expect(p).toMatch(/photorealistic/);
    }
    const neg = shotNegative(plan, { subject });
    expect(neg).toMatch(/human soldier/);
    expect(neg).toMatch(/cartoon/);
    expect(shotNegative(fallbackPlan({ subject: "an anime fox", shots: 1 }), { subject: "an anime fox" })).not.toMatch(/cartoon/);
  });

  it("validates a model's plan and pads short ones", () => {
    const reply = '```json\n{"subjects":"a real orange tabby cat and a german shepherd dog, both wearing tactical vests","setting":"ruined city at dusk","style":"photorealistic","avoid":"human soldier","shots":["the cat sprints across rubble","the dog leaps a wall"]}```';
    const plan = parsePlan(reply, { shots: 6, subject: "a cat and a dog in combat gear" });
    expect(plan.shots).toHaveLength(6);
    expect(plan.subjects).toMatch(/not people/);
    expect(shotPrompt(plan, 1, { subject: "a cat and a dog in combat gear" })).toMatch(/dog leaps a wall/);
    expect(parsePlan("no json here", { shots: 6, subject: "x" })).toBeNull();
    expect(parsePlan('{"subjects":"x y z","shots":["only one shot here"]}', { shots: 6, subject: "x" })).toBeNull();
  });

  it("falls back to camera-varied shots when the model fails", async () => {
    async function* broken() {
      yield { type: "error", data: { message: "down" } };
    }
    const { plan, writer } = await writePlan({ subject: "two foxes", shots: 3 }, { stream: broken });
    expect(writer).toBe("rules");
    expect(plan.shots).toHaveLength(3);
    async function* good() {
      yield { type: "done", data: { text: '{"subjects":"two red foxes","shots":["foxes run","foxes jump","foxes rest"]}' } };
    }
    expect((await writePlan({ subject: "two foxes", shots: 3 }, { stream: good })).writer).toBe("model");
  });
});
