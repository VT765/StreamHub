/**
 * Sample catalog. Videos are generated locally with ffmpeg (see fetch-media.ts) so setup
 * needs no external hosting. Replace with real content by dropping files into server/media.
 */
export interface CatalogEntry {
  slug: string;
  title: string;
  description: string;
  durationSec: number;
  isPremium: boolean;
  /** Gold-only exclusive course. */
  isExclusive?: boolean;
  /** New release: Gold (priority access) gets it this many days before everyone else. */
  earlyAccessDays?: number;
  channelName: string;
  /** ffmpeg lavfi video source expression. */
  lavfi: string;
  /** Audio tone frequency (Hz). */
  tone: number;
}

export const CATALOG: CatalogEntry[] = [
  { slug: 'intro-to-streamhub', title: 'Intro to StreamHub', description: 'A quick tour of the platform and its features.', durationSec: 45, isPremium: false, channelName: 'StreamHub', lavfi: 'testsrc2=size=1280x720:rate=30', tone: 440 },
  { slug: 'fractal-journey', title: 'Fractal Journey', description: 'Zooming deep into the Mandelbrot set.', durationSec: 90, isPremium: false, channelName: 'Math Visuals', lavfi: 'mandelbrot=size=1280x720:rate=30', tone: 330 },
  { slug: 'game-of-life', title: 'Conway’s Game of Life', description: 'Cellular automata evolving in real time.', durationSec: 60, isPremium: false, channelName: 'Math Visuals', lavfi: 'life=size=1280x720:rate=30:mold=10:ratio=0.1:death_color=#1e1b4b:life_color=#f43f5e,scale=1280:720', tone: 523 },
  { slug: 'color-bars-masterclass', title: 'Colour Bars Masterclass', description: 'Everything you ever wanted to know about SMPTE bars.', durationSec: 120, isPremium: true, channelName: 'Broadcast Academy', lavfi: 'smptehdbars=size=1280x720:rate=30', tone: 1000 },
  { slug: 'gradient-meditation', title: 'Gradient Meditation', description: 'New release — slowly shifting colour gradients to relax to.', durationSec: 180, isPremium: true, earlyAccessDays: 60, channelName: 'Calm Studio', lavfi: 'gradients=size=1280x720:rate=30:speed=0.02', tone: 220 },
  { slug: 'cellular-automaton-101', title: 'Cellular Automaton 101', description: 'An introduction to elementary cellular automata.', durationSec: 75, isPremium: false, channelName: 'Math Visuals', lavfi: 'cellauto=size=1280x720:rate=30:rule=110,scale=1280:720', tone: 392 },
  { slug: 'premium-test-pattern', title: 'Course: Advanced Test Patterns', description: 'Gold-exclusive course — a deep dive into broadcast test patterns.', durationSec: 150, isPremium: true, isExclusive: true, channelName: 'Broadcast Academy', lavfi: 'testsrc=size=1280x720:rate=30', tone: 660 },
  { slug: 'rgb-calibration', title: 'RGB Display Calibration', description: 'Calibrate your display with this test sequence.', durationSec: 40, isPremium: false, channelName: 'Broadcast Academy', lavfi: 'rgbtestsrc=size=1280x720:rate=30', tone: 880 },
];
