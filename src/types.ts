/**
 * Types partagés entre les modules d'analyse.
 *
 * Choix technique : chaque module (caches dev, système, applications…)
 * produit une `Section` de `Finding` homogènes — le rapport HTML les rend
 * avec le même composant de tableau, et les éléments actionnables remontent
 * automatiquement dans le « top actions ».
 */
import type { Category } from './knowledge.ts';

export interface Finding {
  /** Libellé affiché (chemin relatif ou nom d'application). */
  label: string;
  path: string;
  sizeBytes: number;
  category: Category;
  /** cache | temporaires | application | images VM | … */
  dataType: string;
  /** Conséquence exacte / recommandation, affichée dans le rapport. */
  note: string;
  /** Commande suggérée (jamais exécutée par l'outil). */
  command?: string;
  /** Date ISO de dernière activité connue, ou null si inconnue. */
  lastActivity?: string | null;
}

export interface Section {
  id: string;
  title: string;
  findings: Finding[];
  /** Recommandations non mesurables (ex. « lancer cleanmgr »). */
  notes: string[];
}
