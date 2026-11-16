import { describe, expect, it } from "vitest";
import { phrasingNote } from "../src/game/phrasing.js";

describe("phrasing note", () => {
  const names = new Set(["mara", "rook", "common", "room"]);
  it("flags narration reused across turns, not a character's own habit or names", () => {
    const outs = [
      'Rain hammers the scarred oak bar. Mara says, "Mild as milk, that one."',
      'You set your cup on the scarred oak bar. Mara laughs. "Mild as milk."',
      'The scarred oak bar creaks under Rook\'s elbows in the common room.',
      'Rook waits in the common room, saying nothing.',
    ];
    const note = phrasingNote(outs, ["Mara", "Rook"], names);
    expect(note).toContain('"scarred oak bar"');
    expect(note).not.toContain("common room");
    expect(note).not.toContain("Said by more than one character");
  });

  it("flags a distinctive phrase that comes from two different characters", () => {
    const outs = ['Mara snorts. "Quiet as a drowned bell, this town."', 'Rook shrugs. "Quiet as a drowned bell out there."'];
    expect(phrasingNote(outs, ["Mara", "Rook"], names)).toMatch(/Said by more than one character lately: "quiet as a drowned" \(Mara, Rook\)/);
  });

  it("leaves a phrase alone when the second speaker heard the first say it", () => {
    const outs = ['Rook leans in. "One season of your hands, Corin."', 'Mara rounds on you. "A season of your hands buys him everything."'];
    expect(phrasingNote(outs, ["Mara", "Rook"], names, [], [["Rook", "Mara"], ["Mara"]])).toBe("");
    expect(phrasingNote(outs, ["Mara", "Rook"], names, [], [["Rook"], ["Mara"]])).toContain("(Rook, Mara)");
  });

  it("is empty when nothing repeats", () => {
    expect(phrasingNote(["You walk in.", "Mara nods."], ["Mara"], names)).toBe("");
  });
});
