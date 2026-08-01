/**
 * Darf mit der eingestellten Batteriekapazität gerechnet werden?
 *
 * ## Warum das eine eigene Frage ist
 *
 * Die Vorgabe von 83,7 kWh ist ein Taycan-Datenblattwert, und sie fließt in
 * JEDE Energie- und Kostenrechnung: geladene kWh, Kosten, Ersparnis,
 * Verbrauch, Standverbrauch, Batterie-Nachweis. Bei einem Cayenne oder
 * Panamera E-Hybrid mit rund 21,8 kWh netto ist das Faktor 3,8.
 *
 * Eine Ladung von 15 auf 95 Prozent bedeutet dort tatsächlich 17,4 kWh für
 * etwa 5,20 Euro. Angezeigt würden 66,96 kWh für 20,09 Euro, und ein
 * Monatsbeleg über zwanzig Ladungen zeigte rund 400 statt 105 Euro. Nichts
 * daran sieht kaputt aus — es gibt keine Fehlermeldung, keine leere Kachel
 * und keine Logzeile. Genau das macht es zum schlimmsten Fehler, den dieses
 * Plugin haben kann.
 *
 * Deshalb wird nicht gefragt, ob eine Zahl DA ist, sondern ob sie zu DIESEM
 * Fahrzeug gehört.
 */
export interface CapacityContext {
  /** Hat der Nutzer die Kapazität selbst eingetragen? */
  fromUser: boolean;
  /** Antriebsart laut Fahrzeug, etwa `BEV`. */
  engine?: string;
  /** Baureihe laut Fahrzeug, etwa `TAYCAN`. */
  model?: string;
}

/**
 * Vertrauenswürdig ist die Kapazität in genau zwei Fällen.
 *
 * Erstens, wenn sie von Hand eingetragen wurde: Wer sie einträgt, hat sie
 * nachgeschlagen — das gilt für jedes Modell und jeden Antrieb.
 *
 * Zweitens, wenn das Fahrzeug sich als Taycan mit reinem Elektroantrieb
 * ausweist. Für dieses eine Modell IST der Vorgabewert der richtige.
 *
 * In allen anderen Fällen nicht, und ausdrücklich auch dann nicht, wenn das
 * Fahrzeug unbekannt ist: Das ist der Zustand beim ersten Start und nach
 * jedem Netzfehler. Eine sichtbare Lücke ist dort besser als eine unsichtbar
 * falsche Zahl.
 */
export function capacityTrusted(ctx: CapacityContext): boolean {
  if (ctx.fromUser) {
    return true;
  }
  return ctx.engine?.toUpperCase() === 'BEV' && ctx.model?.toUpperCase() === 'TAYCAN';
}
