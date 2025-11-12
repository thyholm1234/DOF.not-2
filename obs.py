import os
import json

with open("list_users.json", "r", encoding="utf-8") as f:
    data = json.load(f)
unikke_navne = set(data["unikke_navne"])

obs_dir = os.path.join("web", "obs")
found = set()

for filename in os.listdir(obs_dir):
    path = os.path.join(obs_dir, filename)
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception:
            continue
        for navn in unikke_navne:
            if navn in content:
                found.add(navn)

print("Navne fra unikke_navne fundet i obs/:")
for navn in sorted(found):
    print(navn)