Fonts used on report cards, as on the schools' own cards. Both are free under the SIL Open Font License (OFL-*.txt).

- SpicyRice-Regular.ttf: headings ("Holistic Progress Card", "All About Me"). From github.com/google/fonts (ofl/spicyrice).
- Nunito-Regular.ttf, Nunito-Bold.ttf: text. Latin subset of Nunito from Fontsource (cdn.jsdelivr.net/fontsource/fonts/nunito).

lib/cardStyle.ts embeds them with @pdf-lib/fontkit; if they are missing, the standard PDF fonts are used instead.
