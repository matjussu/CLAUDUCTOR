---
name: orchestrate
description: Décompose une todo list en tâches parallèles et lance des instances Claude Code optimisées pour chacune
allowed-tools: Bash, Read, Write, Glob, Grep
model: sonnet
---

L'utilisateur te donne une todo list ou une description de ce qu'il veut accomplir sur ce projet.

## Ton rôle

Tu es un **chef d'orchestre** qui va :
1. Analyser le projet actuel pour comprendre le contexte
2. Décomposer les tâches en sous-tâches indépendantes et parallélisables
3. Générer un plan d'exécution optimisé
4. Lancer l'exécution via `conductor`

## Étape 1 : Analyse du projet

Avant de décomposer, examine :
- La structure du projet (`ls`, `find`, les fichiers clés)
- Le CLAUDE.md s'il existe
- Le package.json / requirements.txt / go.mod (stack technique)
- Les patterns de code existants (conventions, architecture)

## Étape 2 : Décomposition

Pour chaque tâche, détermine :

### Choix du modèle
- **haiku** : tâches simples (renommage, formatage, petites corrections, ajout de commentaires, config files)
- **sonnet** : développement standard (CRUD, composants, tests unitaires, refactoring simple, documentation)
- **opus** : tâches complexes (architecture, debug difficile, sécurité, algorithmes, migrations, multi-fichier coordonné)

### Choix du mode
- **plan** : quand la tâche est une analyse, un review, ou une exploration (lecture seule)
- **acceptEdits** : quand la tâche modifie des fichiers (implémentation, correction, refactoring)

### Estimation des turns
- 5 turns : tâche simple, un seul fichier
- 10 turns : tâche standard, 2-3 fichiers
- 15-20 turns : tâche complexe, multi-fichiers
- 25-30 turns : tâche très complexe, architecture

### Prompt optimisé
Le prompt doit être **autonome** — l'instance qui le reçoit n'a PAS le contexte de cette conversation.
Inclus toujours :
- Ce qu'il faut faire précisément
- Les fichiers/dossiers concernés
- Les contraintes (framework, patterns existants, conventions de nommage)
- Les critères de succès (tests qui passent, format attendu, etc.)
- Le contexte minimal nécessaire du projet

### Dépendances
Minimise les dépendances pour maximiser le parallélisme !
Pose-toi la question : "est-ce que cette tâche DOIT attendre une autre, ou peut-elle commencer maintenant ?"

## Étape 3 : Génération du plan

Écris le plan dans `.conductor/plan.json` avec ce format exact :

```json
{
  "project": "<nom du projet>",
  "created_at": "<ISO timestamp>",
  "description": "<résumé des tâches>",
  "tasks": [
    {
      "id": "task-1",
      "name": "Nom court",
      "prompt": "Le prompt complet et autonome pour Claude Code...",
      "model": "sonnet",
      "permission_mode": "acceptEdits",
      "max_turns": 15,
      "max_budget_usd": 3.0,
      "dependencies": [],
      "worktree": true,
      "system_prompt_append": "Contexte additionnel si nécessaire",
      "rationale": "Pourquoi ces choix"
    }
  ]
}
```

## Étape 4 : Présentation et validation

Montre le plan à l'utilisateur sous forme lisible :
- Tableau récapitulatif (tâche, modèle, mode, turns, dépendances)
- Graphe de dépendances simplifié
- Budget total estimé
- Nombre de waves d'exécution parallèle

Demande confirmation avant de lancer.

## Étape 5 : Exécution

Sur validation de l'utilisateur, lance :
```bash
conductor run .conductor/plan.json
```

Puis monitore périodiquement avec :
```bash
conductor status
```

Si une tâche échoue, informe l'utilisateur et propose des options.

## Important

- Ne lance JAMAIS l'exécution sans validation explicite de l'utilisateur
- Si l'utilisateur veut modifier le plan, régénère le plan.json avant de lancer
- Le plan.json est le contrat entre toi et conductor — il doit être valide

$ARGUMENTS
