{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  };

  outputs =
    {
      nixpkgs,
      ...
    }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};

      # hb 硬编码依赖 prompt_toolkit==1.0.14 (使用了已在新版本移除的 style_from_dict API)
      prompt_toolkit_legacy = pkgs.python3Packages.buildPythonPackage rec {
        pname = "prompt_toolkit";
        version = "1.0.14";
        pyproject = true;
        build-system = [ pkgs.python3Packages.setuptools ];
        src = pkgs.python3Packages.fetchPypi {
          inherit pname version;
          sha256 = "0bv249ni511lqwjbg6yrvxnv0h76axfx3wnrflb045sb3cxl2rnc";
        };
        postPatch = ''
          find . -name '*.py' -exec sed -i \
            -e 's/from collections import Mapping/from collections.abc import Mapping/' \
            -e 's/from collections import MutableMapping/from collections.abc import MutableMapping/' \
            {} +
        '';
        propagatedBuildInputs = with pkgs.python3Packages; [
          six
          wcwidth
        ];
        doCheck = false;
      };

      # Python 环境及 OpenHarmony hb 构建工具所需依赖
      pythonEnv = pkgs.python3.withPackages (
        ps: [
          ps.setuptools
          ps.pip
          ps.kconfiglib
          ps.pyyaml
          ps.requests
          ps.pycryptodome
          (ps.ecdsa.overridePythonAttrs (old: {
            meta = old.meta // { knownVulnerabilities = [ ]; };
          }))
          prompt_toolkit_legacy
        ]
      );

      hb = pkgs.writeShellScriptBin "hb" ''
        search_dir="$PWD"
        while [ "$search_dir" != / ]; do
          if [ -d "$search_dir/src/build/lite/hb" ]; then
            export PYTHONPATH="$search_dir/src/build/lite''${PYTHONPATH:+:$PYTHONPATH}"
            exec ${pythonEnv}/bin/python -m hb "$@"
          fi
          if [ -d "$search_dir/build/lite/hb" ]; then
            export PYTHONPATH="$search_dir/build/lite''${PYTHONPATH:+:$PYTHONPATH}"
            exec ${pythonEnv}/bin/python -m hb "$@"
          fi
          search_dir="$(dirname "$search_dir")"
        done

        echo "hb: cannot locate src/build/lite/hb from $PWD" >&2
        exit 1
      '';
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        name = "hi3861-openharmony-dev-shell";

        packages = [
          # 构建与编译工具
          pythonEnv
          hb
          pkgs.scons
          pkgs.gnumake

          # LSP 与代码导航工具
          pkgs.clang-tools # clangd 等
          pkgs.bear # 生成 compile_commands.json
        ];

        shellHook = ''
          # 1. 设置编译标志
          export CFLAGS="-Wno-attributes -Wno-cast-function-type -Wno-implicit-function-declaration"
          export CXXFLAGS="-Wno-attributes -Wno-cast-function-type -Wno-implicit-function-declaration"

          # 2. hb 是 python 包（无独立可执行文件），设置 PYTHONPATH
          project_root="''${DIRENV_FILE:+$(dirname "$DIRENV_FILE")}"
          if [ -z "$project_root" ]; then
            project_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
          fi
          hb_module_dir="$project_root/src/build/lite"
          if [ -d "$hb_module_dir/hb" ]; then
            export PYTHONPATH="$hb_module_dir:$PYTHONPATH"
          fi

          # 3. Hi3861 SDK 需要原厂 GCC 7.3 的 soft-float libgcc，默认使用仓库内置工具链。
          export HI3861_TOOLCHAIN="''${HI3861_TOOLCHAIN:-$project_root/toolchains/gcc_riscv32}"
          if [ ! -x "$HI3861_TOOLCHAIN/bin/riscv32-unknown-elf-gcc" ]; then
            echo "错误: HI3861_TOOLCHAIN 中找不到 riscv32-unknown-elf-gcc: $HI3861_TOOLCHAIN" >&2
          else
            export PATH="$HI3861_TOOLCHAIN/bin:$PATH"
          fi

          echo "=========================================================="
          echo "  Hi3861 OpenHarmony 开发与构建环境已就绪 (Nix DevShell)"
          echo "  - 编译器: riscv32-unknown-elf-gcc (HI3861 原厂 GCC 7.3)"
          echo "  - 构建工具: GN, Ninja, SCons, Python (hb)"
          echo "  - 语言服务: clangd, bear"
          echo "  - 编译标志: CFLAGS='$CFLAGS' CXXFLAGS='$CXXFLAGS'"
          echo "=========================================================="
        '';
      };

    };
}
