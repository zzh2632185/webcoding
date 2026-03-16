# MotherDuck Design System & Style Guide

## 1. Overview

### Overall Design Philosophy and Visual Style
The MotherDuck design system utilizes a **Neo-brutalist** visual language customized for a modern, developer-centric audience. It embraces stark contrasts, thick outlines, flat colors, and geometric solid shadows rather than soft blurred elevations. The combination of structural monospaced typography with highly readable sans-serif body text creates a distinctly technical yet approachable aesthetic.

### Brand Tone and Design Goals
- **Technical but Playful:** The design speaks directly to developers, data scientists, and engineers without feeling overly sterile or corporate.
- **Bold and Direct:** High-contrast borders and stark layouts make content easily scannable and digestible.
- **Utilitarian:** The UI elements prioritize clear function over intricate decoration.

### Core Principles of the Design System
1. **Embrace the Line:** A structural 2px solid border (`var(--line)`) is used ubiquitously across containers, buttons, and sections to define boundaries.
2. **Solid over Blurred:** Elevation is depicted through offset solid shapes or physical translations (e.g., buttons shifting on hover) instead of traditional drop shadows.
3. **Monospace for Structure, Sans-serif for Flow:** Monospaced fonts govern headings, navigation, and structural markers, while sans-serif is used for paragraphs and UI controls.

---

## 2. Color Palette

The color system is tight, focusing on warm off-white neutral backgrounds contrasted with striking primary accents and dark, ink-like text.

### Primary Colors
- **Blue (`--blue`)**: `#6fc2ff`
  - *Usage:* Primary button backgrounds, active hover states on links.
- **Yellow (`--yellow`)**: `#ffde00`
  - *Usage:* Attention-grabbing structural banners (eyebrow banner, marquee).

### Secondary & Interaction Colors
- **Strong Blue (`--blue-strong`)**: `#2ba5ff`
  - *Usage:* Active (`:active`) states for primary buttons, deep hover states.
- **Secondary Button Active**: `#e1d6cb`
  - *Usage:* Active state for secondary buttons/surfaces.

### Background and Surface Colors
- **Background (`--bg`)**: `#f4efea`
  - *Usage:* Global page background, secondary button background. A warm, paper-like off-white.
- **Surface (`--surface`)**: `#f8f8f7`
  - *Usage:* Card backgrounds, dropdown menus, and distinct layout blocks. Slightly lighter than the main background.

### Neutral / Grayscale
- **Text & Line (`--text`, `--line`)**: `#383838`
  - *Usage:* The foundational dark gray used for almost all text, 2px structural borders, and outline shapes. Represents the "ink" of the design.
- **Muted Text (`--muted`)**: `#737373`
  - *Usage:* Subtitles, secondary descriptions, and placeholder-like text.
- **Dark Text Variants**: `#5f5f5f`, `#3d3d3d`, `#5e5e5e`
  - *Usage:* Specific card body text for subtle typographic hierarchy.

### Semantic / Accent Card Colors
- **Sun Card (`--sun-card`)**: `#fff1be`
  - *Usage:* Highlighted quote or testimonial cards.
- **Sky Card (`--sky-card`)**: `#d9eeff`
  - *Usage:* Alternate highlighted quote or testimonial cards.

---

## 3. Typography

The typographic system relies on the tension between a mechanical monospace and a clean, highly legible sans-serif.

### Font Families
- **Display & Headings:** `"Aeonik Mono", "Courier New", monospace`
  - *Usage:* `h1`, `h2`, `h3`, `h4`, structural navigation items, eyebrows, buttons.
- **Body & UI:** `"Inter", Arial, sans-serif`
  - *Usage:* `p`, `a`, `li`, `label`, `input`, `button`, body copy.

### Typographic Hierarchy

- **H1 (Hero Display)**
  - *Font:* Aeonik Mono
  - *Weight:* 400 (Normal)
  - *Transform:* Uppercase
  - *Size:* 32px (Mobile) / 56px (Tablet) / 80px (Desktop)
  - *Line Height:* 1.2
- **H2 (Section Headings)**
  - *Font:* Aeonik Mono
  - *Weight:* 400 (Normal)
  - *Transform:* Uppercase
  - *Size:* 26px (Mobile) / 34px (Tablet) / 40px (Desktop)
  - *Line Height:* 1.2
- **H3 (Card Headings & Subsections)**
  - *Font:* Aeonik Mono
  - *Weight:* 400 (Normal)
  - *Transform:* Uppercase
  - *Size:* 22px (Mobile) / 30px (Desktop)
  - *Line Height:* 1.25
- **Body Text (`p`)**
  - *Font:* Inter
  - *Size:* 16px (18px in Hero, 15px in Cards, 14px in Small Cards)
  - *Line Height:* 1.5 (1.6 in Hero)
  - *Letter Spacing:* `0.01em`
- **UI & Controls (Buttons, Inputs, Links)**
  - *Font:* Inter (mostly) and Aeonik Mono (Nav/Menu)
  - *Size:* 14px - 16px
  - *Line Height:* 1.2 - 1.4

### Type Combination Strategy
Monospace is exclusively uppercase when used for headings, establishing a strong, grid-like architectural feel. It is paired with sentence-case Inter for body copy to ensure long-form reading comfort.

---

## 4. Spacing System

The spacing system is generous, designed to let the thick borders and high-contrast elements breathe.

### Base Units
The system loosely follows an 8px/4px hybrid baseline, but utilizes specific fixed values for consistent rhythm:
- Micro: `2px`, `6px`, `8px`
- Small: `10px`, `12px`, `14px`, `16px`
- Medium: `18px`, `20px`, `22px`, `24px`
- Large: `28px`, `30px`, `44px`

### Layout Spacing Guidelines
- **Container Max-Width:** `1302px`
- **Container Padding:** Dynamic based on viewport (`24px` mobile, `20px` tablet, `60px` laptop, `30px` desktop max).
- **Section Padding:** Uses CSS clamps for fluid scaling: `clamp(54px, 8vw, 112px)` top and bottom.
- **Grid Gaps:** Commonly `20px` or `30px` for structural card grids.

---

## 5. Component Styles

### Buttons
Buttons utilize a physical, neo-brutalist interaction model.
- **Structure:** A wrapper `.btn-shell` containing the actual `.btn`.
- **Base Style:** 2px solid `--line` border, 2px border-radius, uppercase text.
- **Padding:** `16px 20px`.
- **Variants:**
  - *Primary:* Background `--blue`.
  - *Secondary:* Background `--bg`.
- **Interaction:** On hover, the inner `.btn` physically translates `translate(7px, -7px)` while the `.btn-shell` reveals a dark background, acting as a hard shadow. On `:active`, it snaps back to `transform: none` and shifts to a darker background color (`--blue-strong`).

### Cards
Cards are structural containers for content arrays, features, and profiles.
- **Structure:** 2px solid `--line` border, 0px border-radius (sharp corners).
- **Background:** `--surface`
- **Padding:** `18px` for inner `.card-body`.
- **Variants:** Profile Cards, Duckling Cards, Quote Cards. Quote cards feature semantic background colors (`--sun-card`, `--sky-card`).

### Inputs
- **Structure:** 100% width, 2px solid `--line` border, 2px border-radius.
- **Background:** `#fff` (True white to stand out from the off-white background).
- **Typography:** 14px Inter.
- **Padding:** `10px 12px`.

### Links
- **Inline Text Links:** Use `text-underline-offset: 0.22em`. Hover states often increase bottom border thickness from 1px to 2px, or change the border color to `--blue`.

---

## 6. Shadows & Elevation

The system **does not use soft, blurred drop-shadows**.

- **Elevation Strategy:** Elevation is conveyed through solid geometric shapes.
- **Layering:** When an element sits above another, it either uses a thick 2px border to separate itself, or utilizes a solid hard shadow (e.g., `box-shadow: 0 8px 0 #d4c7bb` used on the book floating card).
- **Interaction Shadows:** The button hover effect relies on the base shell serving as the shadow when the top element moves diagonally.

---

## 7. Animations & Transitions

Animations are snappy, mechanical, and responsive.

- **Motion Principles:** Transitions should feel like physical switches or cards sliding.
- **Transition Durations:** `120ms ease` for buttons, `150ms ease` for dropdown menus, `200ms ease` for mobile navigation drawers.
- **Continuous Motion:** The marquee component uses a continuous `22s linear infinite` translation to create a dynamic, ticker-tape feel.
- **Interaction Feedback:** Instant visual feedback is prioritized on `:active` states by snapping transformed elements back to their origin.

---

## 8. Border Radius

Border radius is used exceptionally sparingly to maintain the sharp, brutalist aesthetic.

- **Radius Hierarchy:**
  - *0px (Sharp):* Used for almost all structural elements (Cards, Sections, Header, Dropdowns).
  - *2px (Micro):* Used exclusively for interactive controls to slightly soften their tactile feel (Buttons, Inputs).

---

## 9. Opacity & Transparency

The design heavily favors solid, opaque colors to maintain high contrast.
- **Transparency Usage:** Almost non-existent for colors. Hex codes are solid.
- **Visual Layering:** Instead of overlaying elements with opacity, the system uses the `backdrop-filter: blur(2px)` combined with the solid off-white background on the sticky header to create a subtle glass effect when scrolling over content, while maintaining the stark aesthetic.

---

## 10. Common Tailwind CSS Usage (Equivalent Patterns)

If implementing this design system in Tailwind CSS, the following utility patterns would be standard:

- **Borders:** `border-2 border-[#383838]` (Always 2px, always dark text color).
- **Typography:** `font-mono uppercase` for headings, `font-sans` for body.
- **Buttons (Neo-brutalist):**
  ```html
  <div class="inline-block bg-[#383838] rounded-sm">
    <button class="block border-2 border-[#383838] rounded-sm bg-[#6fc2ff] px-5 py-4 uppercase transition-transform duration-150 ease-out hover:-translate-y-2 hover:translate-x-2 active:translate-y-0 active:translate-x-0">
      Click Me
    </button>
  </div>
  ```
- **Cards:** `border-2 border-[#383838] bg-[#f8f8f7] rounded-none p-5`.
- **Layout Spacing:** `py-14 md:py-20 lg:py-28` for section padding.

---

## 11. Example Component Reference Code

### Neo-Brutalist Button
```html
<!-- HTML -->
<a class="btn-shell" href="#">
  <span class="btn primary">Start Free</span>
</a>

<!-- CSS -->
<style>
  .btn-shell {
    display: inline-block;
    background: var(--line);
    border-radius: 2px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 2px solid var(--line);
    border-radius: 2px;
    text-transform: uppercase;
    color: var(--text);
    padding: 16px 20px;
    transition: transform 120ms ease, background-color 120ms ease;
  }
  .btn.primary { background: var(--blue); }
  .btn-shell:hover .btn { transform: translate(7px, -7px); }
  .btn.primary:active { background: var(--blue-strong); transform: none; }
</style>
```

### Standard Structural Card
```html
<!-- HTML -->
<article class="card">
  <div class="card-media">
    <img src="image.jpg" alt="Description">
  </div>
  <div class="card-body">
    <h3>Card Heading</h3>
    <p>This is the standard description text inside a card.</p>
    <a class="card-link" href="#">Learn More</a>
  </div>
</article>

<!-- CSS -->
<style>
  .card {
    border: 2px solid var(--line);
    background: var(--surface);
    display: grid;
    grid-template-rows: auto 1fr;
  }
  .card-media { border-bottom: 2px solid var(--line); }
  .card-body {
    display: grid;
    gap: 12px;
    padding: 18px;
  }
  .card-link {
    text-transform: uppercase;
    text-decoration: none;
    border-bottom: 1px solid var(--line);
    padding-bottom: 1px;
    width: fit-content;
  }
  .card-link:hover { border-bottom-width: 2px; color: var(--blue-strong); }
</style>
```

### Form Input Stack
```html
<!-- HTML -->
<div class="form-stack">
  <input class="text-input" type="email" placeholder="Email address">
  <label class="check">
    <input type="checkbox">
    <span>Subscribe to news</span>
  </label>
</div>

<!-- CSS -->
<style>
  .form-stack { display: grid; gap: 10px; }
  .text-input {
    width: 100%;
    border: 2px solid var(--line);
    border-radius: 2px;
    padding: 10px 12px;
  }
  .check {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 13px;
  }
</style>
```

---

## 12. Additional Design Guidelines

### Grid System
The layout relies on explicit CSS Grid structures (`.grid-2`, `.grid-3`, `.grid-4`, `.grid-5`) rather than a traditional 12-column floating grid.
- Columns auto-fit and break down sequentially as the viewport shrinks.
- Grid gaps are strictly maintained at `20px` to match the thick, chunky layout aesthetic.

### Responsive Design Rules
- **Breakpoints:** The system pivots around 3 major breakpoints:
  - Tablet: `728px`
  - Laptop: `960px`
  - Desktop Max: `1302px`
- **Typography Scaling:** Headings scale dramatically between mobile and desktop (e.g., H1 scales from `32px` to `80px`) to ensure maximum impact on large screens while maintaining readability on mobile.

### Accessibility Considerations
- The high-contrast nature of the 2px black outlines and flat background colors inherently provides excellent WCAG AAA contrast ratios.
- Semantic HTML (`<article>`, `<header>`, `<nav>`, `<details>`, `<summary>`) is strictly utilized, ensuring screen readers can efficiently navigate the DOM structure.
- Focus states should leverage the existing thick border paradigm (e.g., adding an offset outline) rather than soft glowing box-shadows.