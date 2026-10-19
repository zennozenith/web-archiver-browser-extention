{pkgs, ...}: {
  env.GREET = "devenv";

  packages = [
    pkgs.git
    pkgs.librsvg
    pkgs.bash
    pkgs.zip
    pkgs.oxfmt
  ];

  env = {
    NODE_ENV = "development";
    PORT = "3000"; ## For mock server
  };

  tasks."build:all" = {
    exec = "NODE_ENV=production ./build.sh";
  };

  scripts = {
    build-dev.exec = "NODE_ENV=development ./build.sh";
    build-prod.exec = "NODE_ENV=production ./build.sh";
    run-mock.exec = "NODE_ENV=production cd ./mock-server && bun run start";
  };

  languages = {
    typescript.enable = true;
    javascript = {
      enable = true;
      bun.enable = true;
      nodejs.enable = false;
      lsp.enable = false;
    };
  };
}
