import matplotlib.pyplot as plt
import numpy as np

fig, ax = plt.subplots(figsize=(8, 6))
ax.set_aspect('equal')

# Triangle vertices
# Place C at origin, A on x-axis
C = np.array([0, 0])
A = np.array([5, 0])  # b = 5
angle_C = np.radians(40)  # angle C = 40 degrees
B = np.array([3 * np.cos(angle_C), 3 * np.sin(angle_C)])  # a = 3

# Draw triangle
triangle = plt.Polygon([C, A, B], fill=False, edgecolor='black', linewidth=2)
ax.add_patch(triangle)

# Draw altitude from B to AC (x-axis)
H = np.array([B[0], 0])
ax.plot([B[0], H[0]], [B[1], H[1]], 'r--', linewidth=1.5, alpha=0.7)

# Labels
ax.text(C[0]-0.3, C[1]-0.4, 'C', fontsize=16, fontweight='bold')
ax.text(A[0]+0.2, A[1]-0.4, 'A', fontsize=16, fontweight='bold')
ax.text(B[0]-0.3, B[1]+0.3, 'B', fontsize=16, fontweight='bold')

# Side labels
ax.text((A[0]+C[0])/2, (A[1]+C[1])/2 - 0.4, 'b', fontsize=14, color='blue', fontweight='bold')
ax.text((B[0]+C[0])/2 - 0.4, (B[1]+C[1])/2, 'a', fontsize=14, color='blue', fontweight='bold')
mid_AB = (A + B) / 2
ax.text(mid_AB[0]+0.3, mid_AB[1], 'c', fontsize=14, color='blue', fontweight='bold')

# Angle arc at C
angle_arc = np.linspace(0, angle_C, 50)
r = 0.6
ax.plot(r * np.cos(angle_arc), r * np.sin(angle_arc), 'g-', linewidth=1.5)
ax.text(0.8, 0.2, 'C', fontsize=13, color='green', fontweight='bold')

# Right angle marker at H
s = 0.2
ax.plot([H[0]-s, H[0]-s, H[0]], [H[1], H[1]+s, H[1]+s], 'k-', linewidth=1)

# Highlight projection
ax.fill([H[0], B[0]], [H[1], B[1]], color='yellow', alpha=0.15)

# Annotation: show the segments
ax.text((H[0]+A[0])/2, -0.3, 'b - a·cosC', fontsize=11, color='red', ha='center')
ax.text(B[0]/2, -0.3, 'a·cosC', fontsize=11, color='red', ha='center')
ax.text(B[0]+0.3, B[1]/2, 'a·sinC', fontsize=11, color='red', ha='center')

# Title and formula
ax.text(2.5, 3.5, r'余弦定理证明', fontsize=18, fontweight='bold', ha='center')
ax.text(2.5, 3.0, r'c² = a² + b² − 2ab·cosC', fontsize=16, ha='center',
        bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.8))

ax.set_xlim(-1, 6)
ax.set_ylim(-1, 3.5)
ax.axis('off')

plt.tight_layout()
plt.savefig('cosine_theorem_proof.png', dpi=150, bbox_inches='tight', facecolor='white')
print("Proof diagram saved as cosine_theorem_proof.png")
