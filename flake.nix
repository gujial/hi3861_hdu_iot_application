{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  };

  outputs =
    {
      self,
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
        # Python 3.10+ 移除了 collections.Mapping/MutableMapping 别名
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
          prompt_toolkit_legacy
        ]
      );

      # RISC-V 交叉编译工具链 (Hi3861 目标架构)
      riscvToolchain = pkgs.pkgsCross.riscv32-embedded.buildPackages.gcc;
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        name = "hi3861-openharmony-dev-shell";

        packages = [
          # 构建与编译工具
          pythonEnv
          pkgs.gn
          pkgs.ninja
          pkgs.scons
          pkgs.cmake
          pkgs.gnumake
          pkgs.gcc
          pkgs.perl
          pkgs.bison
          pkgs.flex
          pkgs.pkg-config

          # RISC-V 工具链
          riscvToolchain

          # LSP 与代码导航工具
          pkgs.clang-tools # clangd 等
          pkgs.bear # 生成 compile_commands.json
        ];

        shellHook = ''
          # 1. 适配 OpenHarmony 对 riscv32-unknown-elf- 工具链前缀的调用
          mkdir -p .bin
          for bin in ${riscvToolchain}/bin/riscv32-none-elf-*; do
            if [ -f "$bin" ]; then
              target_name="riscv32-unknown-elf-$(basename "$bin" | sed 's/riscv32-none-elf-//')"
              case "$target_name" in
                riscv32-unknown-elf-gcc|riscv32-unknown-elf-g++)
                  # 新版 GCC 对 musl 头文件里 void 返回值加 const 属性报警更严格，
                  # 而项目以 -Werror 编译，需放宽该项警告以兼容旧头文件
                  cat > ".bin/$target_name" <<EOF
#!${pkgs.runtimeShell}
exec "$bin" -Wno-attributes "\$@"
EOF
                  chmod +x ".bin/$target_name"
                  ;;
                *)
                  ln -sf "$bin" ".bin/$target_name"
                  ;;
              esac
            fi
          done
          export PATH="$PWD/.bin:$PATH"

          # 2. hb 是 python 包（无独立可执行文件），生成 python -m hb 的包装脚本
          if [ -d "$PWD/src/build/lite/hb" ]; then
            export PYTHONPATH="$PWD/src/build/lite:$PYTHONPATH"
            cat > .bin/hb <<EOF
#!${pkgs.runtimeShell}
exec ${pythonEnv}/bin/python -m hb "\$@"
EOF
            chmod +x .bin/hb
          fi

          echo "=========================================================="
          echo "  Hi3861 OpenHarmony 开发与构建环境已就绪 (Nix DevShell)"
          echo "  - 编译器: riscv32-unknown-elf-gcc (由 Nix riscv32-none-elf 适配)"
          echo "  - 构建工具: GN, Ninja, SCons, Python (hb)"
          echo "  - 语言服务: clangd, bear"
          echo "=========================================================="
        '';
      };
    };
}
