; Script ajouté au désinstallateur Windows (inclus automatiquement par electron-builder).
; Le programme est toujours supprimé ; ce bloc propose aussi d'effacer les données de l'utilisateur
; (paramètres, clés API, conversations, index du code, documentations, caches).

!macro customUnInstall
  ; Une mise à jour désinstalle l'ancienne version : on garde alors les données.
  ${ifNot} ${isUpdated}
    ; Désinstallation silencieuse (/S) : les données sont conservées, sauf avec l'option /SUPPRIMERDONNEES.
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/SUPPRIMERDONNEES" $R1
    ${if} ${Errors}
      ${if} ${Silent}
        Goto myagentide_keep_data
      ${endIf}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 \
        "Supprimer aussi toutes vos données My Agent IDE ?$\r$\n$\r$\nParamètres, clés API, conversations, index du code, documentations et caches seront effacés de cet ordinateur.$\r$\n$\r$\nChoisissez « Non » pour les conserver en vue d’une réinstallation." \
        /SD IDNO IDNO myagentide_keep_data
    ${endIf}
    SetShellVarContext current
    RMDir /r "$APPDATA\${PRODUCT_NAME}"
    RMDir /r "$LOCALAPPDATA\${PRODUCT_NAME}"
    RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
    myagentide_keep_data:
  ${endIf}
!macroend
