# VHS tape — records demo.gif (ASCII-only typed text: VHS mangles unicode)
# Run from a prepared demo dir (see demo/record.sh): vhs demo.tape
Output demo.gif

Set Shell bash
Set FontSize 21
Set Width 1080
Set Height 640
Set Padding 24
Set TypingSpeed 35ms
Set Theme "Catppuccin Mocha"

Hide
Type "source ./env.sh && clear"
Enter
Sleep 1s
Show

Type "# freshvault is serving this vault - the watcher lives INSIDE the server"
Enter
Sleep 800ms
Type "tail -n0 -f server.log | grep --line-buffered reconciled &"
Enter
Sleep 1s

Type `echo 'Found an incredible tonkotsu place near Fuchu station: Menya Kiraku. Rich broth, thin noodles.' > "vault/Ramen Log.md"`
Enter
Sleep 1s
Type "# note saved. no index command. just wait..."
Enter

# debounce (4s) + embedding - the reconcile log line pops in on its own
Sleep 8s

Type `node ask.mjs "where was that amazing tonkotsu ramen spot?"`
Enter
Sleep 6s

Sleep 3s
