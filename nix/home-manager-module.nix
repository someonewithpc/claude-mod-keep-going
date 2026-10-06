self: { config, lib, pkgs, ... }:
let
  cfg = config.programs.claude-mod-keep-going;
in
{
  options.programs.claude-mod-keep-going = import ./options.nix self { inherit lib pkgs; };

  config = lib.mkIf cfg.enable {
    home.sessionVariables.CLAUDE_CODE_PLUGIN_DIRS = "${cfg.package}";

    xdg.configFile."claude-keep-going/config.json" = lib.mkIf (cfg.settings != { }) {
      text = builtins.toJSON cfg.settings;
    };
  };
}
