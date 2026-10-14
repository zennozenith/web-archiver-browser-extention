{
  pkgs,
  lib,
  config,
  inputs,
  ...
}: {
  env.GREET = "devenv";

  packages = [pkgs.git pkgs.watchexec];

  languages = {
    typescript.enable = true;
    javascript = {
      enable = true;
      bun.enable = true;
      nodejs.enable = false;
      lsp.enable = false;
    };
  };

  tasks."init:frontend" = {
    exec = "vp install";
  };

  tasks."frontend:build" = {
    exec = "vpr lint && vpr fmt && vpr build";
    execIfModified = [
      "src/"
    ];
  };

  scripts.watcher = {
    exec = ''
      watchexec -q -c -w src/ -w ./package.json -w ./vite.config.js -r --stop-signal SIGKILL \
      "devenv tasks run frontend:build"
    '';
    packages = [pkgs.watchexec];
  };
}
