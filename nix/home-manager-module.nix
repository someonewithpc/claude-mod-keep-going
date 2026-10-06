self: { config, lib, pkgs, ... }:
let
  cfg = config.programs.claude-mod-keep-going;
in
{
  options.programs.claude-mod-keep-going = import ./options.nix self { inherit lib pkgs; } // {
    pluginDirsInSettings = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Also put the mod's folder in the env block of ~/.claude/settings.json,
        which Claude Code reads CLAUDE_CODE_PLUGIN_DIRS from as well. A session
        variable reaches only shells started after the next login, and
        settings.json reaches every Claude Code session, however it was started.
        Other folders in the variable are kept; an older keep-going one is
        replaced.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.sessionVariables.CLAUDE_CODE_PLUGIN_DIRS = "${cfg.package}";

    xdg.configFile."claude-keep-going/config.json" = lib.mkIf (cfg.settings != { }) {
      text = builtins.toJSON cfg.settings;
    };

    # Claude Code rewrites settings.json when a setting changes, so it can't
    # be a store symlink: merge the one key in at activation instead.
    home.activation.claudeModKeepGoing = lib.mkIf cfg.pluginDirsInSettings (
      lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        settings="$HOME/.claude/settings.json"
        mkdir -p "$HOME/.claude"
        [ -e "$settings" ] || echo '{}' > "$settings"

        merge='.env = ((.env // {}) + { CLAUDE_CODE_PLUGIN_DIRS:
          ([((.env.CLAUDE_CODE_PLUGIN_DIRS // "") | split(":")[]
             | select(. != "" and (test("-claude-mod-keep-going-") | not)))] + [$dir] | join(":")) })'

        merged=$(${pkgs.jq}/bin/jq --arg dir "${cfg.package}" "$merge" "$settings")
        if [ "$merged" != "$(${pkgs.jq}/bin/jq . "$settings")" ]; then
          $DRY_RUN_CMD install -m 644 /dev/null "$settings.hm-merge"
          printf '%s\n' "$merged" > "$settings.hm-merge"
          $DRY_RUN_CMD mv "$settings.hm-merge" "$settings"
        fi
      ''
    );
  };
}
