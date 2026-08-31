# Directives Layer

This directory contains Standard Operating Procedures (SOPs) and Directives for the Beast Agent.

## Format

Directives should be written in Markdown and include:

- **Goal**: usage of the directive.
- **Inputs**: What information is needed.
- **Tools**: Which tools or scripts to use.
- **Edge Cases**: What to watch out for.

## Usage

The Agent (Layer 2) reads these directives to determine how to execute tasks using the scripts in `../execution/`.
