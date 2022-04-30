#!/bin/bash
yarn install
yarn upgrade
pushd modules
for module in ./*; do
    pushd $module
    yarn install
	yarn upgrade
    popd
done
popd
pushd app
for app in ./*; do
    pushd $app
    yarn install
	yarn upgrade
    popd
done
popd
