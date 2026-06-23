"""Composition layer — the "blueprint" tools for assembling agents.

This layer provides:
- Feature flags (flags.py): Light switches for capabilities
- HarnessConfig (config.py): The serializable agent blueprint
- HarnessBuilder (builder.py): Immutable factory for assembling configs
- Plugins (plugins.py): Reusable capability packages
- Bundles (bundles.py): Pre-composed capability starter packs
"""

from loopengine.composition.flags import FeatureFlag, FlagRegistry, flag
from loopengine.composition.config import HarnessConfig, ProcessorEntry
from loopengine.composition.builder import HarnessBuilder
from loopengine.composition.plugins import Plugin, SimplePlugin, PluginLoader
from loopengine.composition.bundles import (
    make_coding,
    make_reliability,
    make_evaluation,
    make_self_improve,
)

__all__ = [
    # Flags
    "FeatureFlag", "FlagRegistry", "flag",
    # Config
    "HarnessConfig", "ProcessorEntry",
    # Builder
    "HarnessBuilder",
    # Plugins
    "Plugin", "SimplePlugin", "PluginLoader",
    # Bundles
    "make_coding", "make_reliability", "make_evaluation", "make_self_improve",
]
