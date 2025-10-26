import base64
from cryptography.hazmat.primitives.asymmetric import ec
sk = ec.generate_private_key(ec.SECP256R1())
priv = sk.private_numbers().private_value.to_bytes(32, "big")
pubn = sk.public_key().public_numbers()
pub  = b"\x04" + pubn.x.to_bytes(32,"big") + pubn.y.to_bytes(32,"big")
b64  = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
print("PUBLIC =", b64(pub))
print("PRIVATE=", b64(priv))
