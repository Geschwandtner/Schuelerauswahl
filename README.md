This App allows Teachers to select a student from a course/class by an algorithm that works randomly
but leaves a litte probapility for students that have been selected before.
Therefore the number of times a student has already been selected ist stored.
When the selection process starts, a copy of the list of these numbers is made and once a student is chosen randomly, 
the number in this copied list is reduced by 1 if it is > 0.
A student that is chosen and has a number = 0 is selected, if he or she is present. Otherwise the algorithm keeps going.
